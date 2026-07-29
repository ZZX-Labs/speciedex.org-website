/*
========================================================================
Speciedex.org
Terminal Provider Manager
========================================================================

Provider configuration and lifecycle manager for SpeciedexTerminal.

Provides:

    • provider registration and removal
    • enabled and disabled states
    • eligibility controls
    • priority ordering
    • endpoint and documentation metadata
    • schedule and refresh configuration
    • authentication metadata storage
    • validation
    • persistence
    • import and export
    • provider cloning
    • bulk operations
    • integration with provider health
    • library synchronization
    • runtime events
    • terminal commands
    • clean teardown

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME =
        "ProviderManager";

    const VERSION =
        "2.3.1";

    const MANAGER_SYMBOL =
        Symbol.for(
            "speciedex.terminal.providerManager.instance"
        );

    const STORAGE_PREFIX =
        "speciedex-terminal:providers:";

    const RESERVED_KEYS =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
        ]);

    const activeDispatches =
        new WeakMap();

    const DEFAULT_OPTIONS =
        Object.freeze({
            persist:
                true,

            autoSyncLibrary:
                true,

            validateURLs:
                true,

            defaultEnabled:
                true,

            defaultEligible:
                true,

            defaultPriority:
                100,

            defaultRefreshInterval:
                24 * 60 * 60 * 1000,

            historyLimit:
                1000,

            allowDuplicateEndpoints:
                false,

            emitNotifications:
                true,

            catalogURLs:
                [
                    "/static/data/providers.json",
                    "/static/data/providers/providers.json",
                    "/static/data/provider-manifest.json",
                    "/static/data/statistics-sources.json"
                ],

            loadCatalog:
                true,

            syncDebounce:
                75,

            ingestDebounce:
                75,

            maximumProviders:
                1000,

            maximumCatalogRecords:
                5000
        });

    const AUTH_TYPES =
        Object.freeze([
            "none",
            "api-key",
            "bearer",
            "basic",
            "oauth2",
            "custom"
        ]);

    const PROVIDER_TYPES =
        Object.freeze([
            "taxonomy",
            "occurrence",
            "genetics",
            "conservation",
            "geospatial",
            "media",
            "archive",
            "hybrid",
            "unknown"
        ]);

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function isObject(value) {
        return (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        );
    }

    function nowISO(value = Date.now()) {
        const date =
            value instanceof Date
                ? value
                : new Date(value);

        return Number.isFinite(date.getTime())
            ? date.toISOString()
            : new Date().toISOString();
    }

    function dispatch(target, name, detail, options = {}) {
        if (
            !target ||
            typeof target.dispatchEvent !== "function" ||
            !name
        ) {
            return false;
        }

        let names =
            activeDispatches.get(target);

        if (!names) {
            names = new Set();
            activeDispatches.set(target, names);
        }

        if (names.has(name)) {
            return false;
        }

        names.add(name);

        try {
            return target.dispatchEvent(
                new CustomEvent(
                    name,
                    {
                        bubbles:
                            options.bubbles === true,
                        cancelable:
                            options.cancelable === true,
                        detail
                    }
                )
            );
        } catch (_error) {
            return false;
        } finally {
            names.delete(name);
        }
    }

    function safeClone(
        value,
        seen = new WeakMap(),
        depth = 0
    ) {
        if (
            value === null ||
            value === undefined ||
            typeof value !== "object"
        ) {
            return typeof value === "bigint"
                ? String(value)
                : value;
        }

        if (depth > 24) {
            return "[Truncated]";
        }

        if (seen.has(value)) {
            return "[Circular]";
        }

        seen.set(value, true);

        if (value instanceof Date) {
            return nowISO(value);
        }

        if (value instanceof Error) {
            return {
                name: value.name,
                message: value.message,
                stack: value.stack || null
            };
        }

        if (Array.isArray(value)) {
            return value.map(
                item =>
                    safeClone(
                        item,
                        seen,
                        depth + 1
                    )
            );
        }

        const output = {};

        for (
            const [key, item]
            of Object.entries(value)
        ) {
            if (RESERVED_KEYS.has(key)) {
                continue;
            }

            output[key] =
                safeClone(
                    item,
                    seen,
                    depth + 1
                );
        }

        return output;
    }

    function safeStringify(value, compact = false) {
        return JSON.stringify(
            safeClone(value),
            null,
            compact ? 0 : 2
        );
    }

    function normalizeProviderID(value) {
        const id =
            String(
                value ?? ""
            )
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9:_-]+/g, "-")
                .replace(/^-+|-+$/g, "");

        if (!id) {
            throw new Error(
                "Provider ID is required."
            );
        }

        return id;
    }

    function normalizeText(value) {
        return String(
            value ?? ""
        ).trim();
    }

    function normalizeType(value) {
        const type =
            String(
                value ?? ""
            )
                .trim()
                .toLowerCase();

        return PROVIDER_TYPES.includes(
            type
        )
            ? type
            : "unknown";
    }

    function normalizeAuthType(value) {
        const type =
            String(
                value ?? ""
            )
                .trim()
                .toLowerCase();

        return AUTH_TYPES.includes(
            type
        )
            ? type
            : "none";
    }

    function parseBoolean(
        value,
        fallback = false
    ) {
        if (typeof value === "boolean") {
            return value;
        }

        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return fallback;
        }

        const normalized =
            String(value)
                .trim()
                .toLowerCase();

        if (
            ["1", "true", "yes", "on", "enabled"].includes(
                normalized
            )
        ) {
            return true;
        }

        if (
            ["0", "false", "no", "off", "disabled"].includes(
                normalized
            )
        ) {
            return false;
        }

        return fallback;
    }

    function parseNumber(
        value,
        fallback = 0
    ) {
        const parsed =
            Number(value);

        return Number.isFinite(
            parsed
        )
            ? parsed
            : fallback;
    }

    function clampInteger(
        value,
        fallback,
        minimum,
        maximum
    ) {
        const parsed =
            Number.parseInt(
                value,
                10
            );

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(
            maximum,
            Math.max(
                minimum,
                parsed
            )
        );
    }

    function safeStorage() {
        try {
            const key =
                "__speciedex_provider_manager_probe__";

            window.localStorage.setItem(
                key,
                key
            );

            window.localStorage.removeItem(
                key
            );

            return window.localStorage;
        } catch (error) {
            return null;
        }
    }

    function normalizeURL(value) {
        const text =
            normalizeText(
                value
            );

        if (!text) {
            return "";
        }

        try {
            return new URL(
                text,
                window.location?.origin ||
                document.baseURI ||
                "http://localhost/"
            ).href;
        } catch (error) {
            throw new Error(
                `Invalid provider URL: ${value}`
            );
        }
    }

    function normalizeHeaders(value) {
        if (
            !value ||
            typeof value !==
            "object" ||
            Array.isArray(value)
        ) {
            return {};
        }

        return Object.fromEntries(
            Object.entries(value)
                .map(
                    (
                        [
                            key,
                            item
                        ]
                    ) => [
                        String(key).trim(),
                        String(item)
                    ]
                )
                .filter(
                    (
                        [
                            key
                        ]
                    ) =>
                        Boolean(key) &&
                        !RESERVED_KEYS.has(
                            key
                        )
                )
        );
    }

    function normalizeTags(value) {
        if (Array.isArray(value)) {
            return [
                ...new Set(
                    value
                        .map(
                            item =>
                                String(item)
                                    .trim()
                                    .toLowerCase()
                        )
                        .filter(Boolean)
                )
            ];
        }

        if (!value) {
            return [];
        }

        return normalizeTags(
            String(value)
                .split(",")
        );
    }

    function cloneProvider(provider) {
        return safeClone(
            provider
        );
    }

    function serializeProvider(provider) {
        const cloned =
            cloneProvider(
                provider
            );

        if (
            cloned.authentication &&
            cloned.authentication.secret
        ) {
            cloned.authentication.secret =
                "[REDACTED]";
        }

        return cloned;
    }

    function persistenceProvider(provider) {
        const cloned =
            cloneProvider(
                provider
            );

        if (cloned.authentication) {
            cloned.authentication.secret = "";
        }

        return cloned;
    }

    function providerArray(payload) {
        if (Array.isArray(payload)) {
            return payload;
        }

        if (!payload || typeof payload !== "object") {
            return [];
        }

        for (const key of [
            "providers",
            "sources",
            "records",
            "items",
            "data"
        ]) {
            if (Array.isArray(payload[key])) {
                return payload[key];
            }
        }

        return [];
    }

    function stableProviderFingerprint(
        definition
    ) {
        return safeStringify({
            id:
                normalizeProviderID(
                    definition.id ||
                    definition.provider_id ||
                    definition.providerId ||
                    definition.provider ||
                    definition.name
                ),

            name:
                normalizeText(
                    definition.name
                ),

            endpoint:
                normalizeText(
                    definition.endpoint ||
                    definition.url ||
                    definition.endpoints?.primary
                ),

            type:
                normalizeType(
                    definition.type
                ),

            priority:
                parseNumber(
                    definition.priority,
                    0
                ),

            enabled:
                parseBoolean(
                    definition.enabled,
                    true
                ),

            eligible:
                parseBoolean(
                    definition.eligible,
                    true
                )
        });
    }

    function makeHistoryEntry(
        action,
        provider,
        detail = {}
    ) {
        return {
            timestamp:
                nowISO(),

            action,

            provider:
                provider?.id ||
                normalizeText(
                    provider
                ),

            detail
        };
    }

    /*
    ==========================================================================
    Provider Manager
    ==========================================================================
    */

    class ProviderManager
        extends EventTarget {
        constructor(
            context,
            options = {}
        ) {
            super();

            this.context =
                isObject(context)
                    ? context
                    : {};

            this.context.root =
                this.context.root &&
                typeof this.context.root.dispatchEvent ===
                    "function"
                    ? this.context.root
                    : document.documentElement;

            this.options = {
                ...DEFAULT_OPTIONS,
                ...options,
                persist:
                    parseBoolean(
                        options.persist,
                        DEFAULT_OPTIONS.persist
                    ),
                autoSyncLibrary:
                    parseBoolean(
                        options.autoSyncLibrary,
                        DEFAULT_OPTIONS.autoSyncLibrary
                    ),
                validateURLs:
                    parseBoolean(
                        options.validateURLs,
                        DEFAULT_OPTIONS.validateURLs
                    ),
                allowDuplicateEndpoints:
                    parseBoolean(
                        options.allowDuplicateEndpoints,
                        DEFAULT_OPTIONS.allowDuplicateEndpoints
                    ),
                emitNotifications:
                    parseBoolean(
                        options.emitNotifications,
                        DEFAULT_OPTIONS.emitNotifications
                    ),
                loadCatalog:
                    parseBoolean(
                        options.loadCatalog,
                        DEFAULT_OPTIONS.loadCatalog
                    ),
                historyLimit:
                    clampInteger(
                        options.historyLimit,
                        DEFAULT_OPTIONS.historyLimit,
                        10,
                        100000
                    ),
                maximumProviders:
                    clampInteger(
                        options.maximumProviders,
                        DEFAULT_OPTIONS.maximumProviders,
                        1,
                        100000
                    ),
                maximumCatalogRecords:
                    clampInteger(
                        options.maximumCatalogRecords,
                        DEFAULT_OPTIONS.maximumCatalogRecords,
                        1,
                        1000000
                    ),
                syncDebounce:
                    clampInteger(
                        options.syncDebounce,
                        DEFAULT_OPTIONS.syncDebounce,
                        0,
                        60000
                    ),
                ingestDebounce:
                    clampInteger(
                        options.ingestDebounce,
                        DEFAULT_OPTIONS.ingestDebounce,
                        0,
                        60000
                    ),
                catalogURLs:
                    Array.isArray(
                        options.catalogURLs
                    )
                        ? [
                            ...new Set(
                                options.catalogURLs
                                    .map(
                                        normalizeText
                                    )
                                    .filter(Boolean)
                            )
                        ]
                        : [
                            ...DEFAULT_OPTIONS.catalogURLs
                        ]
            };

            this.providers =
                new Map();

            this.history =
                [];

            this.storage =
                safeStorage();

            this.storageKey =
                `${STORAGE_PREFIX}${
                    this.context.root?.
                        dataset.
                        terminalInstance ||
                    "default"
                }`;

            this.destroyed =
                false;

            this.libraryUnsubscribe =
                null;

            this.syncingLibrary =
                false;

            this.ingestingLibrary =
                false;

            this.syncPending =
                false;

            this.ingestPending =
                false;

            this.syncTimer =
                0;

            this.ingestTimer =
                0;

            this.bootstrapped =
                false;

            this.bootstrapPromise =
                null;

            this.catalogPromise =
                null;

            this.abortController =
                typeof AbortController ===
                    "function"
                    ? new AbortController()
                    : null;

            this.watchers =
                new Set();

            this.activeEmits =
                new Set();

            this.boundDisposers =
                [];

            this.seenCatalogRecords =
                new Set();

            this.metrics = {
                bootstraps:
                    0,
                catalogLoads:
                    0,
                catalogImports:
                    0,
                catalogDuplicates:
                    0,
                libraryIngestions:
                    0,
                librarySyncs:
                    0,
                recursiveIngestSkips:
                    0,
                recursiveSyncSkips:
                    0
            };

            if (
                this.options.persist
            ) {
                this.restore();
            }

            this.bootstrap().catch(
                error => {
                    if (!this.destroyed) {
                        this.emit(
                            "bootstrap-error",
                            {
                                error:
                                    error?.message ||
                                    String(error)
                            }
                        );
                    }

                    return this;
                }
            );
        }

        watch(callback, options = {}) {
            this.assertActive();

            if (typeof callback !== "function") {
                throw new TypeError(
                    "Provider-manager watcher must be a function."
                );
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback(
                    {
                        type: "initial",
                        timestamp: nowISO(),
                        summary: this.summary()
                    },
                    this
                );
            }

            return () =>
                this.watchers.delete(
                    callback
                );
        }

        resolveLibrary() {
            return (
                this.context.library ||
                this.context.services?.get?.("library") ||
                this.context.getService?.("library") ||
                null
            );
        }

        resolveHealth() {
            return (
                this.context.providerHealth ||
                this.context.services?.get?.("provider-health") ||
                this.context.getService?.("provider-health") ||
                null
            );
        }

        assertActive() {
            if (
                this.destroyed
            ) {
                throw new Error(
                    "ProviderManager has been destroyed."
                );
            }
        }

        scheduleSyncLibrary() {
            if (
                this.destroyed
            ) {
                return false;
            }

            window.clearTimeout(
                this.syncTimer
            );

            this.syncTimer =
                window.setTimeout(
                    () => {
                        this.syncTimer =
                            0;

                        Promise.resolve(
                            this.syncLibrary()
                        ).catch(
                            error =>
                                this.emit(
                                    "sync-error",
                                    {
                                        error
                                    }
                                )
                        );
                    },
                    Math.max(
                        0,
                        parseNumber(
                            this.options.syncDebounce,
                            DEFAULT_OPTIONS.syncDebounce
                        )
                    )
                );

            return true;
        }

        scheduleIngestLibrary(
            options = {}
        ) {
            if (
                this.destroyed
            ) {
                return false;
            }

            window.clearTimeout(
                this.ingestTimer
            );

            this.ingestTimer =
                window.setTimeout(
                    () => {
                        this.ingestTimer =
                            0;

                        Promise.resolve(
                            this.ingestLibrary(
                                options
                            )
                        ).catch(
                            error =>
                                this.emit(
                                    "ingest-error",
                                    {
                                        error
                                    }
                                )
                        );
                    },
                    Math.max(
                        0,
                        parseNumber(
                            this.options.ingestDebounce,
                            DEFAULT_OPTIONS.ingestDebounce
                        )
                    )
                );

            return true;
        }

        async bootstrap() {
            if (
                this.destroyed
            ) {
                return this;
            }

            if (
                this.bootstrapped
            ) {
                return this;
            }

            if (
                this.bootstrapPromise
            ) {
                return this.bootstrapPromise;
            }

            this.bootstrapPromise =
                (async () => {
                    this.metrics.bootstraps +=
                        1;

                    await this.ingestLibrary({
                        persist:
                            false,
                        sync:
                            false,
                        emit:
                            false,
                        source:
                            "bootstrap"
                    });

                    this.bindLibrary();

                    if (
                        this.options.loadCatalog
                    ) {
                        await this.loadCatalog()
                            .catch(
                                error =>
                                    this.emit(
                                        "catalog-error",
                                        {
                                            error:
                                                error.message
                                        }
                                    )
                            );
                    }

                    if (
                        this.destroyed
                    ) {
                        return this;
                    }

                    this.persist();
                    await this.syncLibrary();

                    this.bootstrapped =
                        true;

                    this.emit(
                        "ready",
                        this.summary()
                    );

                    return this;
                })();

            try {
                return await this.bootstrapPromise;
            } finally {
                this.bootstrapPromise =
                    null;
            }
        }

        async loadCatalog(options = {}) {
            this.assertActive();

            if (
                this.catalogPromise &&
                options.refresh !==
                    true
            ) {
                return this.catalogPromise;
            }

            const urls =
                Array.isArray(options.urls)
                    ? options.urls
                    : this.options.catalogURLs;

            if (typeof fetch !== "function") {
                throw new Error(
                    "Fetch is unavailable in this environment."
                );
            }

            this.catalogPromise = (async () => {
                this.metrics.catalogLoads +=
                    1;

                const imported = [];
                const warnings = [];

                for (const url of urls || []) {
                    try {
                        const response =
                            await fetch(
                                url,
                                {
                                    method:
                                        "GET",
                                    headers: {
                                        Accept:
                                            "application/json"
                                    },
                                    credentials:
                                        "same-origin",
                                    cache:
                                        options.refresh === true
                                            ? "reload"
                                            : "default",

                                    signal:
                                        this.abortController?.signal
                                }
                            );

                        if (!response.ok) {
                            if (response.status !== 404) {
                                warnings.push({
                                    url,
                                    error:
                                        `HTTP ${response.status}`
                                });
                            }
                            continue;
                        }

                        const payload =
                            await response.json();

                        const rows =
                            providerArray(
                                payload
                            ).slice(
                                0,
                                this.options.maximumCatalogRecords
                            );

                        if (!rows.length) {
                            continue;
                        }

                        for (const row of rows) {
                            const definition = {
                                ...row,
                                id:
                                    row.id ||
                                    row.provider_id ||
                                    row.providerId ||
                                    row.provider ||
                                    row.name
                            };

                            if (!definition.id) {
                                continue;
                            }

                            let fingerprint;

                            try {
                                fingerprint =
                                    stableProviderFingerprint(
                                        definition
                                    );
                            } catch (error) {
                                warnings.push({
                                    url,
                                    provider:
                                        definition.id,
                                    error:
                                        error.message
                                });

                                continue;
                            }

                            if (
                                this.seenCatalogRecords.has(
                                    fingerprint
                                )
                            ) {
                                this.metrics.catalogDuplicates +=
                                    1;

                                continue;
                            }

                            this.seenCatalogRecords.add(
                                fingerprint
                            );

                            try {
                                const provider =
                                    this.register(
                                        definition,
                                        {
                                            merge:
                                                true,
                                            persist:
                                                false,
                                            sync:
                                                false,
                                            history:
                                                false
                                        }
                                    );

                                imported.push(
                                    provider.id
                                );

                                this.metrics.catalogImports +=
                                    1;
                            } catch (error) {
                                warnings.push({
                                    url,
                                    provider:
                                        definition.id,
                                    error:
                                        error.message
                                });
                            }
                        }
                    } catch (error) {
                        warnings.push({
                            url,
                            error:
                                error.message
                        });
                    }
                }

                if (imported.length) {
                    this.persist();

                    await this.syncLibrary().catch(
                        error => {
                            this.emit(
                                "sync-error",
                                {
                                    error:
                                        error?.message ||
                                        String(error),
                                    source:
                                        "catalog"
                                }
                            );

                            return false;
                        }
                    );
                }

                const result = {
                    imported:
                        [...new Set(imported)],
                    warnings
                };

                this.emit(
                    "catalog-loaded",
                    result
                );

                return result;
            })();

            try {
                return await this.catalogPromise;
            } finally {
                this.catalogPromise = null;
            }
        }

        /*
        ======================================================================
        Validation
        ======================================================================
        */

        validate(
            definition,
            options = {}
        ) {
            const errors =
                [];

            const warnings =
                [];

            let id;

            try {
                id =
                    normalizeProviderID(
                        definition.id ||
                        definition.name
                    );
            } catch (error) {
                errors.push(
                    error.message
                );
            }

            const name =
                normalizeText(
                    definition.name
                );

            if (!name) {
                warnings.push(
                    "Provider name is empty."
                );
            }

            const endpoint =
                definition.endpoint ||
                definition.url ||
                definition.endpoints?.primary ||
                "";

            if (
                endpoint &&
                this.options.validateURLs
            ) {
                try {
                    normalizeURL(
                        endpoint
                    );
                } catch (error) {
                    errors.push(
                        error.message
                    );
                }
            }

            const documentation =
                definition.documentation ||
                definition.docs ||
                "";

            if (
                documentation &&
                this.options.validateURLs
            ) {
                try {
                    normalizeURL(
                        documentation
                    );
                } catch (error) {
                    warnings.push(
                        error.message
                    );
                }
            }

            if (
                definition.priority !==
                    undefined &&
                !Number.isFinite(
                    Number(
                        definition.priority
                    )
                )
            ) {
                errors.push(
                    "Provider priority must be numeric."
                );
            }

            if (
                definition.refreshInterval !==
                    undefined &&
                Number(
                    definition.refreshInterval
                ) <
                    0
            ) {
                errors.push(
                    "Provider refresh interval cannot be negative."
                );
            }

            if (
                !this.options.allowDuplicateEndpoints &&
                endpoint
            ) {
                const normalizedEndpoint =
                    normalizeURL(
                        endpoint
                    );

                for (const provider of this.providers.values()) {
                    if (
                        provider.id !==
                            id &&
                        provider.endpoints.primary ===
                            normalizedEndpoint
                    ) {
                        errors.push(
                            `Endpoint is already used by provider "${provider.id}".`
                        );

                        break;
                    }
                }
            }

            if (
                options.requireEndpoint ===
                    true &&
                !endpoint
            ) {
                errors.push(
                    "Provider endpoint is required."
                );
            }

            return {
                valid:
                    errors.length ===
                    0,

                id:
                    id ||
                    null,

                errors,
                warnings
            };
        }

        normalizeDefinition(
            definition,
            existing = null
        ) {
            if (
                !definition ||
                typeof definition !==
                "object"
            ) {
                throw new TypeError(
                    "Provider definition must be an object."
                );
            }

            const validation =
                this.validate(
                    definition
                );

            if (!validation.valid) {
                throw new Error(
                    validation.errors.join(
                        " "
                    )
                );
            }

            const now =
                nowISO();

            const id =
                validation.id;

            const endpoint =
                definition.endpoint ||
                definition.url ||
                definition.endpoints?.primary ||
                existing?.endpoints?.primary ||
                "";

            const endpoints = {
                ...(
                    isObject(
                        existing?.endpoints
                    )
                        ? safeClone(
                            existing.endpoints
                        )
                        : {}
                ),
                ...(
                    isObject(
                        definition.endpoints
                    )
                        ? safeClone(
                            definition.endpoints
                        )
                        : {}
                )
            };

            if (endpoint) {
                endpoints.primary =
                    normalizeURL(
                        endpoint
                    );
            }

            for (
                const [
                    key,
                    value
                ] of Object.entries(
                    endpoints
                )
            ) {
                if (value) {
                    endpoints[
                        key
                    ] =
                        normalizeURL(
                            value
                        );
                }
            }

            const authentication = {
                type:
                    normalizeAuthType(
                        definition.authentication?.type ||
                        definition.authType ||
                        existing?.authentication?.type ||
                        "none"
                    ),

                keyName:
                    normalizeText(
                        definition.authentication?.keyName ||
                        definition.keyName ||
                        existing?.authentication?.keyName ||
                        ""
                    ),

                secret:
                    definition.authentication?.secret ??
                    definition.secret ??
                    existing?.authentication?.secret ??
                    "",

                headers:
                    normalizeHeaders({
                        ...(existing?.authentication?.headers || {}),
                        ...(definition.authentication?.headers || {}),
                        ...(definition.headers || {})
                    }),

                queryParameter:
                    normalizeText(
                        definition.authentication?.queryParameter ||
                        existing?.authentication?.queryParameter ||
                        ""
                    )
            };

            const schedule = {
                enabled:
                    parseBoolean(
                        definition.schedule?.enabled ??
                        definition.scheduled ??
                        existing?.schedule?.enabled,
                        true
                    ),

                refreshInterval:
                    Math.max(
                        0,
                        parseNumber(
                            definition.schedule?.refreshInterval ??
                            definition.refreshInterval ??
                            existing?.schedule?.refreshInterval,
                            this.options.defaultRefreshInterval
                        )
                    ),

                timezone:
                    normalizeText(
                        definition.schedule?.timezone ||
                        existing?.schedule?.timezone ||
                        "UTC"
                    ),

                nextRun:
                    definition.schedule?.nextRun ??
                    existing?.schedule?.nextRun ??
                    null,

                lastRun:
                    definition.schedule?.lastRun ??
                    existing?.schedule?.lastRun ??
                    null
            };

            return {
                id,

                name:
                    normalizeText(
                        definition.name ||
                        existing?.name ||
                        id
                    ),

                type:
                    normalizeType(
                        definition.type ||
                        existing?.type ||
                        "unknown"
                    ),

                description:
                    normalizeText(
                        definition.description ||
                        existing?.description ||
                        ""
                    ),

                enabled:
                    parseBoolean(
                        definition.enabled,
                        existing?.enabled ??
                        this.options.defaultEnabled
                    ),

                eligible:
                    parseBoolean(
                        definition.eligible,
                        existing?.eligible ??
                        this.options.defaultEligible
                    ),

                priority:
                    clampInteger(
                        definition.priority,
                        existing?.priority ??
                        this.options.defaultPriority,
                        -1000000,
                        1000000
                    ),

                endpoints,

                documentation:
                    (
                        definition.documentation ||
                        definition.docs ||
                        existing?.documentation
                    )
                        ? normalizeURL(
                            definition.documentation ||
                            definition.docs ||
                            existing?.documentation
                        )
                        : "",

                homepage:
                    (
                        definition.homepage ||
                        existing?.homepage
                    )
                        ? normalizeURL(
                            definition.homepage ||
                            existing?.homepage
                        )
                        : "",

                license:
                    normalizeText(
                        definition.license ||
                        existing?.license ||
                        ""
                    ),

                country:
                    normalizeText(
                        definition.country ||
                        existing?.country ||
                        ""
                    ),

                tags:
                    normalizeTags(
                        definition.tags ??
                        existing?.tags
                    ),

                capabilities:
                    normalizeTags(
                        definition.capabilities ??
                        existing?.capabilities
                    ),

                authentication,

                schedule,

                createdAt:
                    existing?.createdAt ||
                    now,

                updatedAt:
                    now,

                revision:
                    (
                        existing?.revision ||
                        0
                    ) +
                    1,

                metadata: {
                    ...(
                        isObject(
                            existing?.metadata
                        )
                            ? safeClone(
                                existing.metadata
                            )
                            : {}
                    ),
                    ...(
                        isObject(
                            definition.metadata
                        )
                            ? safeClone(
                                definition.metadata
                            )
                            : {}
                    )
                }
            };
        }

        /*
        ======================================================================
        Core Operations
        ======================================================================
        */

        register(
            definition,
            options = {}
        ) {
            this.assertActive();

            const id =
                normalizeProviderID(
                    definition.id ||
                    definition.name
                );

            const existing =
                this.providers.get(
                    id
                ) ||
                null;

            if (
                !existing &&
                this.providers.size >=
                    this.options.maximumProviders
            ) {
                throw new Error(
                    `Provider limit reached: ${this.options.maximumProviders}`
                );
            }

            if (
                existing &&
                options.replace !==
                    true &&
                options.merge !==
                    true
            ) {
                throw new Error(
                    `Provider already exists: ${id}`
                );
            }

            const normalized =
                this.normalizeDefinition(
                    options.replace ===
                        true
                        ? definition
                        : {
                            ...(existing || {}),
                            ...definition
                        },
                    options.replace ===
                        true
                        ? null
                        : existing
                );

            this.providers.set(
                id,
                normalized
            );

            if (options.history !== false) {
                this.recordHistory(
                    existing
                        ? "update"
                        : "register",
                    normalized,
                    {
                        replace:
                            options.replace ===
                            true,
                        merge:
                            options.merge ===
                            true
                    }
                );
            }

            if (options.persist !== false) {
                this.persist();
            }

            if (
                options.sync !== false &&
                this.options.autoSyncLibrary
            ) {
                this.scheduleSyncLibrary();
            }

            this.syncHealth(
                normalized
            );
            this.emit(
                existing
                    ? "updated"
                    : "registered",
                {
                    provider:
                        serializeProvider(
                            normalized
                        )
                }
            );

            return cloneProvider(
                normalized
            );
        }

        update(
            id,
            patch
        ) {
            const normalizedID =
                normalizeProviderID(
                    id
                );

            const existing =
                this.providers.get(
                    normalizedID
                );

            if (!existing) {
                throw new Error(
                    `Unknown provider: ${normalizedID}`
                );
            }

            return this.register(
                {
                    ...patch,
                    id:
                        normalizedID
                },
                {
                    merge:
                        true
                }
            );
        }

        remove(
            id
        ) {
            const normalizedID =
                normalizeProviderID(
                    id
                );

            const provider =
                this.providers.get(
                    normalizedID
                );

            if (!provider) {
                return false;
            }

            this.providers.delete(
                normalizedID
            );

            this.recordHistory(
                "remove",
                provider
            );

            this.persist();

            if (this.options.autoSyncLibrary) {
                this.scheduleSyncLibrary();
            }
            this.emit(
                "removed",
                {
                    provider:
                        serializeProvider(
                            provider
                        )
                }
            );

            return true;
        }

        get(
            id,
            options = {}
        ) {
            const provider =
                this.providers.get(
                    normalizeProviderID(
                        id
                    )
                ) ||
                null;

            if (!provider) {
                return null;
            }

            return options.redact ===
                false
                ? cloneProvider(
                    provider
                )
                : serializeProvider(
                    provider
                );
        }

        has(
            id
        ) {
            return this.providers.has(
                normalizeProviderID(
                    id
                )
            );
        }

        clone(
            sourceID,
            destinationID,
            overrides = {}
        ) {
            const source =
                this.providers.get(
                    normalizeProviderID(
                        sourceID
                    )
                );

            if (!source) {
                throw new Error(
                    `Unknown provider: ${sourceID}`
                );
            }

            const destination =
                normalizeProviderID(
                    destinationID
                );

            if (
                this.providers.has(
                    destination
                )
            ) {
                throw new Error(
                    `Provider already exists: ${destination}`
                );
            }

            return this.register({
                ...cloneProvider(
                    source
                ),

                ...overrides,

                id:
                    destination,

                name:
                    overrides.name ||
                    `${source.name} Copy`,

                createdAt:
                    undefined,

                updatedAt:
                    undefined,

                revision:
                    undefined
            });
        }

        /*
        ======================================================================
        State Operations
        ======================================================================
        */

        setEnabled(
            id,
            enabled
        ) {
            return this.update(
                id,
                {
                    enabled:
                        Boolean(
                            enabled
                        )
                }
            );
        }

        enable(
            id
        ) {
            return this.setEnabled(
                id,
                true
            );
        }

        disable(
            id
        ) {
            return this.setEnabled(
                id,
                false
            );
        }

        setEligible(
            id,
            eligible
        ) {
            return this.update(
                id,
                {
                    eligible:
                        Boolean(
                            eligible
                        )
                }
            );
        }

        setPriority(
            id,
            priority
        ) {
            return this.update(
                id,
                {
                    priority:
                        clampInteger(
                            priority,
                            this.options.defaultPriority,
                            -1000000,
                            1000000
                        )
                }
            );
        }

        setEndpoint(
            id,
            endpoint,
            name =
                "primary"
        ) {
            const provider =
                this.providers.get(
                    normalizeProviderID(
                        id
                    )
                );

            if (!provider) {
                throw new Error(
                    `Unknown provider: ${id}`
                );
            }

            return this.update(
                id,
                {
                    endpoints: {
                        ...provider.endpoints,
                        [
                            normalizeText(
                                name
                            ) ||
                            "primary"
                        ]:
                            normalizeURL(
                                endpoint
                            )
                    }
                }
            );
        }

        setSchedule(
            id,
            schedule
        ) {
            const provider =
                this.providers.get(
                    normalizeProviderID(
                        id
                    )
                );

            if (!provider) {
                throw new Error(
                    `Unknown provider: ${id}`
                );
            }

            return this.update(
                id,
                {
                    schedule: {
                        ...provider.schedule,
                        ...schedule
                    }
                }
            );
        }

        setAuthentication(
            id,
            authentication
        ) {
            const provider =
                this.providers.get(
                    normalizeProviderID(
                        id
                    )
                );

            if (!provider) {
                throw new Error(
                    `Unknown provider: ${id}`
                );
            }

            return this.update(
                id,
                {
                    authentication: {
                        ...provider.authentication,
                        ...authentication
                    }
                }
            );
        }

        bulk(
            ids,
            operation,
            value = null
        ) {
            this.assertActive();

            const results =
                [];

            const previousSync =
                this.options.autoSyncLibrary;

            this.options.autoSyncLibrary =
                false;

            try {
                for (const id of ids) {
                    try {
                        let result;

                        switch (operation) {
                            case "enable":
                                result =
                                    this.enable(
                                        id
                                    );
                                break;

                            case "disable":
                                result =
                                    this.disable(
                                        id
                                    );
                                break;

                            case "eligible":
                                result =
                                    this.setEligible(
                                        id,
                                        true
                                    );
                                break;

                            case "ineligible":
                                result =
                                    this.setEligible(
                                        id,
                                        false
                                    );
                                break;

                            case "priority":
                                result =
                                    this.setPriority(
                                        id,
                                        value
                                    );
                                break;

                            case "remove":
                                result =
                                    this.remove(
                                        id
                                    );
                                break;

                            default:
                                throw new Error(
                                    `Unsupported provider bulk operation: ${operation}`
                                );
                        }

                        results.push({
                            id,
                            success:
                                true,
                            result
                        });
                    } catch (error) {
                        results.push({
                            id,
                            success:
                                false,
                            error:
                                error.message
                        });
                    }
                }
            } finally {
                this.options.autoSyncLibrary =
                    previousSync;

                this.persist();

                if (previousSync) {
                    this.scheduleSyncLibrary();
                }
            }

            return results;
        }

        /*
        ======================================================================
        Listing and Queries
        ======================================================================
        */

        list(
            options = {}
        ) {
            const type =
                options.type
                    ? normalizeType(
                        options.type
                    )
                    : null;

            const enabled =
                options.enabled;

            const eligible =
                options.eligible;

            const tag =
                normalizeText(
                    options.tag
                ).toLowerCase();

            const contains =
                normalizeText(
                    options.contains ||
                    options.text
                ).toLowerCase();

            let providers =
                [
                    ...this.providers.values()
                ].filter(
                    provider =>
                        (
                            !type ||
                            provider.type ===
                            type
                        ) &&
                        (
                            enabled ===
                                undefined ||
                            provider.enabled ===
                            enabled
                        ) &&
                        (
                            eligible ===
                                undefined ||
                            provider.eligible ===
                            eligible
                        ) &&
                        (
                            !tag ||
                            provider.tags.includes(
                                tag
                            )
                        ) &&
                        (
                            !contains ||
                            [
                                provider.id,
                                provider.name,
                                provider.description,
                                provider.type,
                                provider.country,
                                provider.license,
                                provider.documentation,
                                provider.homepage,
                                provider.tags.join(
                                    " "
                                ),
                                provider.capabilities.join(
                                    " "
                                )
                            ]
                                .join(" ")
                                .toLowerCase()
                                .includes(
                                    contains
                                )
                        )
                );

            const sort =
                String(
                    options.sort ||
                    "priority"
                );

            providers.sort(
                (
                    left,
                    right
                ) => {
                    switch (sort) {
                        case "name":
                            return left.name.localeCompare(
                                right.name
                            );

                        case "updated":
                            return Date.parse(
                                right.updatedAt
                            ) -
                            Date.parse(
                                left.updatedAt
                            );

                        case "type":
                            return left.type.localeCompare(
                                right.type
                            );

                        case "priority":
                        default:
                            return (
                                left.priority -
                                right.priority
                            ) ||
                            left.name.localeCompare(
                                right.name
                            );
                    }
                }
            );

            const limit =
                clampInteger(
                    options.limit,
                    providers.length ||
                    1,
                    1,
                    10000
                );

            return providers
                .slice(
                    0,
                    limit
                )
                .map(
                    provider =>
                        options.redact ===
                            false
                            ? cloneProvider(
                                provider
                            )
                            : serializeProvider(
                                provider
                            )
                );
        }

        enabled() {
            return this.list({
                enabled:
                    true
            });
        }

        eligible() {
            return this.list({
                eligible:
                    true
            });
        }

        prioritized() {
            return this.list({
                enabled:
                    true,
                eligible:
                    true,
                sort:
                    "priority"
            });
        }

        summary() {
            const providers =
                [
                    ...this.providers.values()
                ];

            const byType =
                Object.fromEntries(
                    PROVIDER_TYPES.map(
                        type => [
                            type,
                            0
                        ]
                    )
                );

            for (const provider of providers) {
                byType[
                    provider.type
                ] =
                    (
                        byType[
                            provider.type
                        ] ||
                        0
                    ) +
                    1;
            }

            return {
                version:
                    VERSION,

                providers:
                    providers.length,

                enabled:
                    providers.filter(
                        provider =>
                            provider.enabled
                    ).length,

                eligible:
                    providers.filter(
                        provider =>
                            provider.eligible
                    ).length,

                active:
                    providers.filter(
                        provider =>
                            provider.enabled &&
                            provider.eligible
                    ).length,

                scheduled:
                    providers.filter(
                        provider =>
                            provider.schedule.enabled
                    ).length,

                authenticated:
                    providers.filter(
                        provider =>
                            provider.authentication.type !==
                            "none"
                    ).length,

                byType,

                history:
                    this.history.length,

                bootstrapped:
                    this.bootstrapped,

                syncingLibrary:
                    this.syncingLibrary,

                ingestingLibrary:
                    this.ingestingLibrary,

                syncPending:
                    this.syncPending,

                ingestPending:
                    this.ingestPending,

                catalogLoading:
                    Boolean(
                        this.catalogPromise
                    ),

                destroyed:
                    this.destroyed,

                activeEmits:
                    this.activeEmits.size,

                librarySubscribed:
                    Boolean(
                        this.libraryUnsubscribe
                    ),

                metrics:
                    safeClone(
                        this.metrics
                    )
            };
        }

        /*
        ======================================================================
        Library Synchronization
        ======================================================================
        */

        async ingestLibrary(
            options = {}
        ) {
            if (this.destroyed) {
                return [];
            }

            if (this.ingestingLibrary) {
                this.ingestPending = true;
                this.metrics.recursiveIngestSkips += 1;
                return [];
            }

            const library =
                this.resolveLibrary();

            if (!library) {
                return [];
            }

            this.ingestingLibrary = true;
            this.ingestPending = false;

            const collections = [
                "providers",
                "enabled-providers",
                "eligible-providers"
            ];

            const imported = [];

            const getCollection =
                async name => {
                    const result =
                        library.get?.(
                            name
                        );

                    return result &&
                    typeof result.then ===
                        "function"
                        ? await result
                        : result;
                };

            try {
                for (
                    const collection
                    of collections
                ) {
                    const records =
                        await getCollection(
                            collection
                        ) ||
                        [];

                    if (!Array.isArray(records)) {
                        continue;
                    }

                    for (const record of records) {
                        if (!isObject(record)) {
                            continue;
                        }

                        const id =
                            record.id ||
                            record.provider_id ||
                            record.providerId ||
                            record.provider ||
                            record.name;

                        if (!id) {
                            continue;
                        }

                        const definition = {
                            ...safeClone(record),
                            id,
                            enabled:
                                collection ===
                                    "enabled-providers"
                                    ? true
                                    : record.enabled,
                            eligible:
                                collection ===
                                    "eligible-providers"
                                    ? true
                                    : record.eligible
                        };

                        try {
                            const provider =
                                this.register(
                                    definition,
                                    {
                                        merge: true,
                                        persist: false,
                                        sync: false,
                                        history:
                                            options.history ===
                                            true
                                    }
                                );

                            imported.push(
                                provider.id
                            );
                        } catch (error) {
                            if (options.emit !== false) {
                                this.emit(
                                    "ingest-error",
                                    {
                                        collection,
                                        record:
                                            safeClone(
                                                record
                                            ),
                                        error:
                                            error.message
                                    }
                                );
                            }
                        }
                    }
                }

                const unique = [
                    ...new Set(imported)
                ];

                if (unique.length) {
                    if (options.persist !== false) {
                        this.persist();
                    }

                    if (
                        options.sync !== false &&
                        this.options.autoSyncLibrary
                    ) {
                        this.scheduleSyncLibrary();
                    }
                }

                this.metrics.libraryIngestions += 1;

                if (options.emit !== false) {
                    this.emit(
                        "library-ingested",
                        {
                            providers:
                                unique,
                            count:
                                unique.length,
                            source:
                                options.source ||
                                "library"
                        }
                    );
                }

                return unique;
            } finally {
                this.ingestingLibrary = false;

                if (
                    this.ingestPending &&
                    !this.destroyed
                ) {
                    this.ingestPending = false;

                    this.scheduleIngestLibrary({
                        history: false,
                        source: "pending"
                    });
                }
            }
        }

        async syncLibrary() {
            if (this.destroyed) {
                return false;
            }

            const library =
                this.resolveLibrary();

            if (
                !this.options.autoSyncLibrary ||
                !library
            ) {
                return false;
            }

            if (this.syncingLibrary) {
                this.syncPending = true;
                this.metrics.recursiveSyncSkips += 1;
                return false;
            }

            const providers =
                this.list({
                    redact: false
                });

            this.syncingLibrary = true;
            this.syncPending = false;

            try {
                const sync =
                    async () => {
                        await library.set?.(
                            "providers",
                            providers,
                            {
                                source:
                                    "provider-manager",
                                description:
                                    "Speciedex provider configuration registry."
                            }
                        );

                        await library.set?.(
                            "enabled-providers",
                            providers.filter(
                                provider =>
                                    provider.enabled
                            ),
                            {
                                source:
                                    "provider-manager"
                            }
                        );

                        await library.set?.(
                            "eligible-providers",
                            providers.filter(
                                provider =>
                                    provider.eligible
                            ),
                            {
                                source:
                                    "provider-manager"
                            }
                        );
                    };

                if (
                    typeof library.batch ===
                        "function"
                ) {
                    const result =
                        library.batch(sync);

                    if (
                        result &&
                        typeof result.then ===
                            "function"
                    ) {
                        await result;
                    }
                } else {
                    await sync();
                }

                this.metrics.librarySyncs += 1;

                this.emit(
                    "library-synced",
                    {
                        providers:
                            providers.length
                    }
                );

                return true;
            } finally {
                this.syncingLibrary = false;

                if (
                    this.syncPending &&
                    !this.destroyed
                ) {
                    this.syncPending = false;
                    this.scheduleSyncLibrary();
                }
            }
        }

        bindLibrary() {
            const library =
                this.resolveLibrary();

            if (
                !this.options.autoSyncLibrary ||
                !library?.subscribe ||
                this.libraryUnsubscribe
            ) {
                return false;
            }

            const subscription =
                library.subscribe(
                    "*",
                    event => {
                        if (
                            this.destroyed ||
                            this.syncingLibrary ||
                            event?.source ===
                                "provider-manager"
                        ) {
                            return;
                        }

                        if (
                            [
                                "providers",
                                "enabled-providers",
                                "eligible-providers"
                            ].includes(
                                event.collection
                            )
                        ) {
                            this.scheduleIngestLibrary({
                                history:
                                    false,
                                source:
                                    `library:${event.collection}`
                            });
                        }
                    }
                );

            this.libraryUnsubscribe =
                typeof subscription ===
                    "function"
                    ? subscription
                    : subscription &&
                        typeof subscription.unsubscribe ===
                            "function"
                        ? () =>
                            subscription.unsubscribe()
                        : null;

            return Boolean(
                this.libraryUnsubscribe
            );
        }

        /*
        ======================================================================
        Health Integration
        ======================================================================
        */

        syncHealth(
            provider
        ) {
            if (
                this.destroyed
            ) {
                return false;
            }

            const health =
                this.resolveHealth();

            if (
                !health ||
                health.destroyed
            ) {
                return false;
            }

            health.registerProvider?.(
                provider.id,
                {
                    ...serializeProvider(
                        provider
                    ),

                    endpoint:
                        provider.endpoints.primary ||
                        ""
                }
            );

            return true;
        }

        async check(
            id,
            options = {}
        ) {
            const health =
                this.resolveHealth();

            if (!health?.checkProvider) {
                throw new Error(
                    "Provider health service is unavailable."
                );
            }

            return health.checkProvider(
                id,
                options
            );
        }

        /*
        ======================================================================
        Persistence
        ======================================================================
        */

        persist() {
            if (
                !this.options.persist ||
                !this.storage
            ) {
                return false;
            }

            try {
                this.storage.setItem(
                    this.storageKey,
                    safeStringify({
                        version:
                            VERSION,

                        providers:
                            [
                                ...this.providers.values()
                            ].map(
                                persistenceProvider
                            ),

                        history:
                            this.history.slice(
                                -this.options.historyLimit
                            )
                    })
                );

                return true;
            } catch (error) {
                this.emit(
                    "persistence-error",
                    {
                        error:
                            error.message
                    }
                );

                return false;
            }
        }

        restore() {
            if (!this.storage) {
                return [];
            }

            try {
                const payload =
                    JSON.parse(
                        this.storage.getItem(
                            this.storageKey
                        ) ||
                        "null"
                    );

                if (
                    !payload ||
                    !Array.isArray(
                        payload.providers
                    )
                ) {
                    return [];
                }

                for (const provider of payload.providers) {
                    try {
                        const normalized =
                            this.normalizeDefinition(
                                provider,
                                null
                            );

                        this.providers.set(
                            normalized.id,
                            normalized
                        );
                    } catch (error) {
                        this.emit(
                            "restore-error",
                            {
                                provider,
                                error:
                                    error.message
                            }
                        );
                    }
                }

                this.history =
                    Array.isArray(
                        payload.history
                    )
                        ? safeClone(
                            payload.history.slice(
                                -this.options.historyLimit
                            )
                        )
                        : [];

                return this.list();
            } catch (error) {
                this.emit(
                    "restore-error",
                    {
                        error:
                            error.message
                    }
                );

                return [];
            }
        }

        resetPersistence() {
            try {
                this.storage?.removeItem(
                    this.storageKey
                );
            } catch (error) {
                /*
                --------------------------------------------------------------
                Ignore unavailable storage.
                --------------------------------------------------------------
                */
            }
        }

        /*
        ======================================================================
        Import and Export
        ======================================================================
        */

        import(
            payload,
            options = {}
        ) {
            let providers;

            if (Array.isArray(payload)) {
                providers =
                    payload;
            } else if (
                payload &&
                Array.isArray(
                    payload.providers
                )
            ) {
                providers =
                    payload.providers;
            } else {
                throw new Error(
                    "Provider import payload must contain a providers array."
                );
            }

            const results =
                [];

            for (const definition of providers) {
                try {
                    results.push({
                        success:
                            true,

                        provider:
                            this.register(
                                definition,
                                {
                                    replace:
                                        options.replace ===
                                        true,

                                    merge:
                                        options.replace !==
                                        true
                                }
                            )
                    });
                } catch (error) {
                    results.push({
                        success:
                            false,

                        provider:
                            definition?.id ||
                            definition?.name ||
                            null,

                        error:
                            error.message
                    });
                }
            }

            return results;
        }

        export(
            options = {}
        ) {
            return {
                version:
                    VERSION,

                generatedAt:
                    nowISO(),

                summary:
                    this.summary(),

                providers:
                    this.list({
                        redact:
                            options.includeSecrets ===
                            true
                                ? false
                                : true
                    }),

                history:
                    [
                        ...this.history
                    ]
            };
        }

        exportCSV() {
            const rows =
                this.list();

            const header = [
                "id",
                "name",
                "type",
                "enabled",
                "eligible",
                "priority",
                "primary_endpoint",
                "documentation",
                "homepage",
                "license",
                "country",
                "refresh_interval_ms",
                "schedule_enabled",
                "auth_type",
                "tags",
                "capabilities",
                "updated_at"
            ];

            const escape =
                value => {
                    const text =
                        String(
                            value ?? ""
                        );

                    return /[",\n\r]/.test(
                        text
                    )
                        ? `"${text.replace(/"/g, '""')}"`
                        : text;
                };

            const lines = [
                header.join(",")
            ];

            for (const provider of rows) {
                lines.push(
                    [
                        provider.id,
                        provider.name,
                        provider.type,
                        provider.enabled,
                        provider.eligible,
                        provider.priority,
                        provider.endpoints.primary ||
                            "",
                        provider.documentation,
                        provider.homepage,
                        provider.license,
                        provider.country,
                        provider.schedule.refreshInterval,
                        provider.schedule.enabled,
                        provider.authentication.type,
                        provider.tags.join(
                            "|"
                        ),
                        provider.capabilities.join(
                            "|"
                        ),
                        provider.updatedAt
                    ]
                        .map(
                            escape
                        )
                        .join(",")
                );
            }

            return lines.join(
                "\n"
            );
        }

        /*
        ======================================================================
        History and Events
        ======================================================================
        */

        recordHistory(
            action,
            provider,
            detail = {}
        ) {
            const entry =
                makeHistoryEntry(
                    action,
                    provider,
                    detail
                );

            this.history.push(
                entry
            );

            this.history =
                this.history.slice(
                    -this.options.historyLimit
                );

            return entry;
        }

        emit(
            type,
            detail = {}
        ) {
            if (
                this.destroyed &&
                type !== "destroy"
            ) {
                return false;
            }

            const eventType =
                String(
                    type ||
                    ""
                ).trim();

            if (
                !eventType ||
                this.activeEmits.has(
                    eventType
                )
            ) {
                return false;
            }

            const payload =
                safeClone(
                    detail
                );

            this.activeEmits.add(
                eventType
            );

            try {
                dispatch(
                    this,
                    eventType,
                    payload
                );

                for (
                    const watcher
                    of Array.from(
                        this.watchers
                    )
                ) {
                    try {
                        watcher(
                            {
                                type:
                                    eventType,
                                timestamp:
                                    nowISO(),
                                detail:
                                    safeClone(
                                        payload
                                    )
                            },
                            this
                        );
                    } catch (_error) {
                        /* Watcher failures are isolated. */
                    }
                }

                try {
                    this.context.events?.emit?.(
                        `provider-manager:${eventType}`,
                        payload
                    );
                } catch (_error) {
                    /* External event-bus failures are isolated. */
                }

                dispatch(
                    this.context.root,
                    `speciedex:terminal-provider-manager-${eventType}`,
                    payload,
                    {
                        bubbles:
                            true
                    }
                );

                if (
                    !this.context.root ||
                    !this.context.root.isConnected
                ) {
                    dispatch(
                        document,
                        `speciedex:terminal-provider-manager-${eventType}`,
                        payload
                    );
                }

                return true;
            } finally {
                this.activeEmits.delete(
                    eventType
                );
            }
        }

        async run(
            parameters = {}
        ) {
            const action =
                parameters.action ||
                parameters.args?.[0] ||
                "list";

            switch (action) {
                case "summary":
                case "status":
                    return this.summary();

                case "enabled":
                    return this.enabled();

                case "eligible":
                    return this.eligible();

                case "prioritized":
                    return this.prioritized();

                case "refresh":
                case "reload":
                    return this.loadCatalog({
                        refresh:
                            true
                    });

                case "list":
                default:
                    return this.list(parameters);
            }
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            try {
                this.abortController?.abort?.();
            } catch (_error) {
                /* Continue teardown. */
            }

            window.clearTimeout(
                this.syncTimer
            );

            window.clearTimeout(
                this.ingestTimer
            );

            try {
                this.libraryUnsubscribe?.();
            } catch (_error) {
                /* Continue teardown. */
            }

            this.emit(
                "destroy",
                {
                    version:
                        VERSION
                }
            );

            this.libraryUnsubscribe = null;
            this.watchers.clear();
            this.activeEmits.clear();
            this.syncPending = false;
            this.ingestPending = false;
            this.syncTimer = 0;
            this.ingestTimer = 0;
            this.providers.clear();
            this.history = [];
            this.seenCatalogRecords.clear();

            if (
                this.context.root?.[
                    MANAGER_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    MANAGER_SYMBOL
                ];
            }

            if (
                this.context.providerManager ===
                    this
            ) {
                delete this.context.providerManager;
            }

            if (
                this.context.providermanager ===
                    this
            ) {
                delete this.context.providermanager;
            }

            this.destroyed = true;

            return true;
        }

    }

    /*
    ==========================================================================
    Initialization
    ==========================================================================
    */

    function initialize(
        context = {}
    ) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const root =
            safeContext.root &&
            typeof safeContext.root.dispatchEvent ===
                "function"
                ? safeContext.root
                : document.documentElement;

        const existing =
            safeContext.providerManager instanceof
                ProviderManager
                ? safeContext.providerManager
                : safeContext.services?.get?.(
                    "provider-manager"
                ) ||
                safeContext.services?.get?.(
                    "providers"
                ) ||
                root?.[
                    MANAGER_SYMBOL
                ];

        if (
            existing instanceof
                ProviderManager &&
            !existing.destroyed
        ) {
            safeContext.providerManager =
                existing;

            safeContext.providermanager =
                existing;

            safeContext.registerService?.(
                "provider-manager",
                existing
            );

            safeContext.registerService?.(
                "providers",
                existing
            );

            return existing;
        }

        const dataset =
            root.dataset || {};

        const config =
            safeContext.config?.
                providerManager ||
            safeContext.config?.
                providermanager ||
            {};

        const service =
            new ProviderManager(
                {
                    ...safeContext,
                    root
                },
                {
                    persist:
                        parseBoolean(
                            dataset.
                                terminalProviderManagerPersist ??
                            config.persist,
                            DEFAULT_OPTIONS.persist
                        ),

                    autoSyncLibrary:
                        parseBoolean(
                            dataset.
                                terminalProviderManagerSyncLibrary ??
                            config.autoSyncLibrary,
                            DEFAULT_OPTIONS.autoSyncLibrary
                        ),

                    validateURLs:
                        parseBoolean(
                            dataset.
                                terminalProviderManagerValidateUrls ??
                            config.validateURLs,
                            DEFAULT_OPTIONS.validateURLs
                        ),

                    allowDuplicateEndpoints:
                        parseBoolean(
                            dataset.
                                terminalProviderManagerAllowDuplicateEndpoints ??
                            config.allowDuplicateEndpoints,
                            DEFAULT_OPTIONS.allowDuplicateEndpoints
                        ),

                    emitNotifications:
                        parseBoolean(
                            dataset.
                                terminalProviderManagerNotifications ??
                            config.emitNotifications,
                            DEFAULT_OPTIONS.emitNotifications
                        ),

                    loadCatalog:
                        parseBoolean(
                            dataset.
                                terminalProviderManagerLoadCatalog ??
                            config.loadCatalog,
                            DEFAULT_OPTIONS.loadCatalog
                        ),

                    historyLimit:
                        clampInteger(
                            dataset.
                                terminalProviderManagerHistory ??
                            config.historyLimit,
                            DEFAULT_OPTIONS.historyLimit,
                            10,
                            100000
                        ),

                    syncDebounce:
                        parseNumber(
                            dataset.
                                terminalProviderManagerSyncDebounce ??
                            config.syncDebounce,
                            DEFAULT_OPTIONS.syncDebounce
                        ),

                    ingestDebounce:
                        parseNumber(
                            dataset.
                                terminalProviderManagerIngestDebounce ??
                            config.ingestDebounce,
                            DEFAULT_OPTIONS.ingestDebounce
                        ),

                    maximumProviders:
                        clampInteger(
                            dataset.
                                terminalProviderManagerMaximumProviders ??
                            config.maximumProviders,
                            DEFAULT_OPTIONS.maximumProviders,
                            1,
                            100000
                        ),

                    maximumCatalogRecords:
                        clampInteger(
                            dataset.
                                terminalProviderManagerMaximumCatalogRecords ??
                            config.maximumCatalogRecords,
                            DEFAULT_OPTIONS.maximumCatalogRecords,
                            1,
                            1000000
                        ),

                    catalogURLs:
                        config.catalogURLs ||
                        DEFAULT_OPTIONS.catalogURLs
                }
            );

        root[
            MANAGER_SYMBOL
        ] =
            service;

        safeContext.providerManager =
            service;

        safeContext.providermanager =
            service;

        safeContext.registerService?.(
            "provider-manager",
            service
        );

        safeContext.registerService?.(
            "providers",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-provider-manager-ready",
            {
                context:
                    safeContext,
                service,
                version:
                    VERSION
            }
        );

        return service;
    }

    /*
    ==========================================================================
    Download Helper
    ==========================================================================
    */

    function download(
        content,
        filename,
        mime,
        context = {}
    ) {
        const exporter =
            context.exporter ||
            context.services?.get?.(
                "export"
            ) ||
            context.services?.get?.(
                "exporter"
            );

        if (
            exporter &&
            typeof exporter.download ===
                "function"
        ) {
            exporter.download(
                content,
                filename,
                mime
            );

            return filename;
        }

        if (
            typeof URL?.createObjectURL !==
                "function"
        ) {
            throw new Error(
                "Browser download URLs are unavailable."
            );
        }

        const blob =
            new Blob(
                [content],
                {
                    type:
                        mime
                }
            );

        const url =
            URL.createObjectURL(
                blob
            );

        const anchor =
            document.createElement(
                "a"
            );

        anchor.href = url;
        anchor.download = filename;

        (
            document.body ||
            document.documentElement
        ).appendChild(anchor);

        try {
            anchor.click();
        } finally {
            anchor.remove();

            window.setTimeout(
                () =>
                    URL.revokeObjectURL(
                        url
                    ),
                1000
            );
        }

        return filename;
    }

    /*
    ==========================================================================
    Commands
    ==========================================================================
    */

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function requireProviderManager(
        context = {}
    ) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const service =
            safeContext.providerManager ||
            safeContext.services?.get?.(
                "provider-manager"
            ) ||
            safeContext.services?.get?.(
                "providers"
            ) ||
            initialize(safeContext);

        if (
            !(service instanceof ProviderManager) ||
            service.destroyed
        ) {
            throw new Error(
                "Provider manager is unavailable."
            );
        }

        return service;
    }

    function writeResult(
        payload,
        value,
        type = "data"
    ) {
        if (
            typeof payload.writeJSON ===
                "function" &&
            typeof value !==
                "string"
        ) {
            return payload.writeJSON(
                value
            );
        }

        if (
            typeof payload.write ===
                "function"
        ) {
            return payload.write(
                typeof value ===
                    "string"
                    ? value
                    : safeStringify(
                        value
                    ),
                type
            );
        }

        if (
            typeof payload.writeLine ===
                "function"
        ) {
            return payload.writeLine(
                typeof value ===
                    "string"
                    ? value
                    : safeStringify(
                        value
                    )
            );
        }

        return value;
    }

    const commands =
        [
            {
                name:
                    "provider-manager",

                category:
                    "data",

                description:
                    "Inspect provider-manager state.",

                usage:
                    "provider-manager [list|summary|enabled|eligible|prioritized|refresh]",

                handler: async ({
                    args = [],
                    context,
                    writeJSON
                }) => {
                    const service =
                        context.services?.get?.(
                            "provider-manager"
                        ) ||
                        context.providerManager;

                    if (!service) {
                        throw new Error(
                            "Provider manager is unavailable."
                        );
                    }

                    return writeJSON(
                        await service.run({
                            args
                        })
                    );
                }
            },

            {
                name:
                    "provider-sync",

                category:
                    "data",

                description:
                    "Synchronize provider-manager collections into the terminal library.",

                usage:
                    "provider-sync",

                handler: async ({
                    context,
                    writeJSON
                }) =>
                    writeJSON({
                        synchronized:
                            await context.providerManager.syncLibrary(),
                        summary:
                            context.providerManager.summary()
                    })
            },

            {
                name:
                    "provider-refresh-library",

                category:
                    "data",

                description:
                    "Refresh provider-manager state from terminal library collections.",

                usage:
                    "provider-refresh-library",

                handler: async ({
                    context,
                    writeJSON
                }) =>
                    writeJSON({
                        imported:
                            await context.providerManager.ingestLibrary({
                                source:
                                    "command"
                            }),
                        summary:
                            context.providerManager.summary()
                    })
            },

            {
                name:
                    "provider-add",

                category:
                    "data",

                description:
                    "Register a provider.",

                usage:
                    "provider-add <id> <name> [endpoint] [--type TYPE] [--priority N] [--disabled] [--ineligible]",

                handler: ({
                    args,
                    parsed,
                    context,
                    writeJSON
                }) => {
                    const id =
                        args.shift();

                    const name =
                        args.shift();

                    const endpoint =
                        args.shift() ||
                        parsed.options.endpoint ||
                        "";

                    if (
                        !id ||
                        !name
                    ) {
                        throw new Error(
                            "Usage: provider-add <id> <name> [endpoint]"
                        );
                    }

                    return writeJSON(
                        context.providerManager.register({
                            id,
                            name,
                            endpoint,
                            type:
                                parsed.options.type ||
                                "unknown",
                            priority:
                                parsed.options.priority,
                            enabled:
                                parsed.flags.disabled
                                    ? false
                                    : true,
                            eligible:
                                parsed.flags.ineligible
                                    ? false
                                    : true,
                            documentation:
                                parsed.options.documentation ||
                                parsed.options.docs ||
                                "",
                            homepage:
                                parsed.options.homepage ||
                                "",
                            license:
                                parsed.options.license ||
                                "",
                            country:
                                parsed.options.country ||
                                "",
                            tags:
                                parsed.options.tags ||
                                "",
                            capabilities:
                                parsed.options.capabilities ||
                                ""
                        })
                    );
                }
            },

            {
                name:
                    "provider-get",

                category:
                    "data",

                description:
                    "Display one provider configuration.",

                usage:
                    "provider-get <id>",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    const provider =
                        context.providerManager.get(
                            args[0]
                        );

                    if (!provider) {
                        throw new Error(
                            `Unknown provider: ${args[0]}`
                        );
                    }

                    return writeJSON(
                        provider
                    );
                }
            },

            {
                name:
                    "provider-remove",

                category:
                    "data",

                description:
                    "Remove a provider.",

                usage:
                    "provider-remove <id>",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const id =
                        args[0];

                    if (!id) {
                        throw new Error(
                            "A provider ID is required."
                        );
                    }

                    if (
                        !context.providerManager.remove(
                            id
                        )
                    ) {
                        throw new Error(
                            `Unknown provider: ${id}`
                        );
                    }

                    return write(
                        `Provider removed: ${id}`,
                        "success"
                    );
                }
            },

            {
                name:
                    "provider-enable",

                category:
                    "data",

                description:
                    "Enable a provider.",

                usage:
                    "provider-enable <id>",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.providerManager.enable(
                            args[0]
                        )
                    )
            },

            {
                name:
                    "provider-disable",

                category:
                    "data",

                description:
                    "Disable a provider.",

                usage:
                    "provider-disable <id>",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.providerManager.disable(
                            args[0]
                        )
                    )
            },

            {
                name:
                    "provider-eligible",

                category:
                    "data",

                description:
                    "Set provider eligibility.",

                usage:
                    "provider-eligible <id> <true|false>",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    if (
                        args.length <
                        2
                    ) {
                        throw new Error(
                            "Usage: provider-eligible <id> <true|false>"
                        );
                    }

                    return writeJSON(
                        context.providerManager.setEligible(
                            args[0],
                            parseBoolean(
                                args[1],
                                true
                            )
                        )
                    );
                }
            },

            {
                name:
                    "provider-priority",

                category:
                    "data",

                description:
                    "Set provider priority.",

                usage:
                    "provider-priority <id> <priority>",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    if (
                        args.length <
                        2
                    ) {
                        throw new Error(
                            "Usage: provider-priority <id> <priority>"
                        );
                    }

                    return writeJSON(
                        context.providerManager.setPriority(
                            args[0],
                            args[1]
                        )
                    );
                }
            },

            {
                name:
                    "provider-endpoint",

                category:
                    "data",

                description:
                    "Set a provider endpoint.",

                usage:
                    "provider-endpoint <id> <url> [name]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    if (
                        args.length <
                        2
                    ) {
                        throw new Error(
                            "Usage: provider-endpoint <id> <url> [name]"
                        );
                    }

                    return writeJSON(
                        context.providerManager.setEndpoint(
                            args[0],
                            args[1],
                            args[2] ||
                            "primary"
                        )
                    );
                }
            },

            {
                name:
                    "provider-schedule",

                category:
                    "data",

                description:
                    "Configure provider refresh scheduling.",

                usage:
                    "provider-schedule <id> <interval-ms> [enabled]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    if (
                        args.length <
                        2
                    ) {
                        throw new Error(
                            "Usage: provider-schedule <id> <interval-ms> [enabled]"
                        );
                    }

                    return writeJSON(
                        context.providerManager.setSchedule(
                            args[0],
                            {
                                refreshInterval:
                                    parseNumber(
                                        args[1],
                                        DEFAULT_OPTIONS.defaultRefreshInterval
                                    ),

                                enabled:
                                    args[2] ===
                                        undefined
                                        ? true
                                        : parseBoolean(
                                            args[2],
                                            true
                                        )
                            }
                        )
                    );
                }
            },

            {
                name:
                    "provider-clone",

                category:
                    "data",

                description:
                    "Clone a provider configuration.",

                usage:
                    "provider-clone <source-id> <destination-id> [name]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    if (
                        args.length <
                        2
                    ) {
                        throw new Error(
                            "Usage: provider-clone <source-id> <destination-id> [name]"
                        );
                    }

                    return writeJSON(
                        context.providerManager.clone(
                            args[0],
                            args[1],
                            {
                                name:
                                    args.slice(
                                        2
                                    ).join(
                                        " "
                                    ) ||
                                    undefined
                            }
                        )
                    );
                }
            },

            {
                name:
                    "provider-validate",

                category:
                    "data",

                description:
                    "Validate a provider definition or existing provider.",

                usage:
                    "provider-validate <id>",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    const provider =
                        context.providerManager.get(
                            args[0],
                            {
                                redact:
                                    false
                            }
                        );

                    if (!provider) {
                        throw new Error(
                            `Unknown provider: ${args[0]}`
                        );
                    }

                    return writeJSON(
                        context.providerManager.validate(
                            provider,
                            {
                                requireEndpoint:
                                    true
                            }
                        )
                    );
                }
            },

            {
                name:
                    "provider-check",

                category:
                    "data",

                description:
                    "Run a provider health check.",

                usage:
                    "provider-check <id> [--timeout MS] [--method HEAD|GET]",

                handler: async ({
                    args,
                    parsed,
                    context,
                    writeJSON
                }) => {
                    if (!args[0]) {
                        throw new Error(
                            "A provider ID is required."
                        );
                    }

                    return writeJSON(
                        await context.providerManager.check(
                            args[0],
                            {
                                timeout:
                                    parsed.options.timeout,
                                method:
                                    parsed.options.method
                            }
                        )
                    );
                }
            },

            {
                name:
                    "provider-import",

                category:
                    "data",

                description:
                    "Import provider definitions from a library collection.",

                usage:
                    "provider-import [collection]",

                handler: async ({
                    args,
                    context,
                    writeJSON
                }) => {
                    const collection =
                        args[0] ||
                        "providers-import";

                    const library =
                        context.library ||
                        context.services?.get?.(
                            "library"
                        );

                    const result =
                        library?.get?.(
                            collection
                        );

                    const records =
                        result &&
                        typeof result.then ===
                            "function"
                            ? await result
                            : result ||
                            [];

                    return writeJSON(
                        context.providerManager.import(
                            records
                        )
                    );
                }
            },

            {
                name:
                    "provider-export",

                category:
                    "data",

                description:
                    "Export provider configurations as JSON or CSV.",

                usage:
                    "provider-export [json|csv] [filename]",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const format =
                        String(
                            args[0] ||
                            "json"
                        ).toLowerCase();

                    if (
                        format ===
                        "csv"
                    ) {
                        const filename =
                            args[1] ||
                            "speciedex-providers.csv";

                        download(
                            context.providerManager.exportCSV(),
                            filename,
                            "text/csv;charset=utf-8",
                            context
                        );

                        return write(
                            `Providers exported to ${filename}.`,
                            "success"
                        );
                    }

                    const filename =
                        args[1] ||
                        "speciedex-providers.json";

                    download(
                        safeStringify(
                            context.providerManager.export()
                        ),
                        filename,
                        "application/json;charset=utf-8",
                        context
                    );

                    return write(
                        `Providers exported to ${filename}.`,
                        "success"
                    );
                }
            }
        ];

    for (const command of commands) {
        const handler =
            command.handler;

        command.handler =
            payload => {
                const safePayload =
                    isObject(payload)
                        ? payload
                        : {};

                safePayload.context =
                    resolveCommandContext(
                        safePayload
                    );

                const manager =
                    requireProviderManager(
                        safePayload.context
                    );

                safePayload.context.providerManager =
                    manager;

                safePayload.context.providermanager =
                    manager;

                safePayload.args =
                    Array.isArray(
                        safePayload.args
                    )
                        ? [
                            ...safePayload.args
                        ]
                        : [];

                safePayload.parsed =
                    isObject(
                        safePayload.parsed
                    )
                        ? safePayload.parsed
                        : {
                            flags: {},
                            options: {}
                        };

                safePayload.parsed.flags =
                    isObject(
                        safePayload.parsed.flags
                    )
                        ? safePayload.parsed.flags
                        : {};

                safePayload.parsed.options =
                    isObject(
                        safePayload.parsed.options
                    )
                        ? safePayload.parsed.options
                        : {};

                safePayload.writeJSON =
                    typeof safePayload.writeJSON ===
                        "function"
                        ? safePayload.writeJSON
                        : value =>
                            writeResult(
                                safePayload,
                                value
                            );

                safePayload.write =
                    typeof safePayload.write ===
                        "function"
                        ? safePayload.write
                        : (
                            value,
                            type
                        ) =>
                            writeResult(
                                safePayload,
                                value,
                                type
                            );

                return handler(
                    safePayload
                );
            };
    }

    /*
    ==========================================================================
    Public Module API
    ==========================================================================
    */

    const api =
        Object.freeze({
            name:
                MODULE_NAME,

            version:
                VERSION,

            STORAGE_PREFIX,
            MANAGER_SYMBOL,
            DEFAULT_OPTIONS,
            AUTH_TYPES,
            PROVIDER_TYPES,
            ProviderManager,

            normalizeProviderID,
            normalizeText,
            normalizeType,
            normalizeAuthType,
            parseBoolean,
            parseNumber,
            clampInteger,
            normalizeURL,
            normalizeHeaders,
            normalizeTags,
            cloneProvider,
            serializeProvider,
            persistenceProvider,
            providerArray,
            stableProviderFingerprint,
            dispatch,
            safeClone,
            safeStringify,
            resolveCommandContext,

            initialize,
            mount:
                initialize,
            init:
                initialize,
            setup:
                initialize,

            commands
        });

    window.SpeciedexTerminalProviderManager =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules ||
        {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] =
        api;

    dispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name:
                MODULE_NAME,
            module:
                api
        }
    );
})(window, document);