"use strict";

/*
==============================================================================
Speciedex.org
Statistics Module
==============================================================================

Loaded by:

    /static/js/script.js

Responsibilities:

    • Load statistics.json through the shared Data module
    • Load statistics-sources.json when available
    • Populate original and expanded splash statistics
    • Support HTML partials inserted after module initialization
    • Bind explicit element IDs and generic [data-stat] elements
    • Format numeric values consistently
    • Display timestamps in America/New_York
    • Gracefully handle unavailable values
    • Dispatch statistics lifecycle events
    • Avoid duplicate fetches, duplicate observers, and event storms
    • Recover cleanly when the Data module loads after this module
    • Preserve the existing public Speciedex statistics API

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
==============================================================================
*/

(() => {
    const Speciedex =
        window.Speciedex =
        window.Speciedex || {};

    if (Speciedex.statisticsModuleLoaded) {
        return;
    }

    Speciedex.statisticsModuleLoaded = true;

    /*
    ==========================================================================
    Configuration
    ==========================================================================
    */

    const MODULE_NAME =
        "Statistics";

    const VERSION =
        "2.2.0";

    const DATA_FILE =
        "statistics.json";

    const SOURCES_FILE =
        "statistics-sources.json";

    const DISPLAY_TIME_ZONE =
        "America/New_York";

    const RETRY_DELAY =
        250;

    const RETRY_LIMIT =
        40;

    const MUTATION_DEBOUNCE =
        40;

    const PARTIAL_DEBOUNCE =
        20;

    const SELECTORS =
        Object.freeze({
            species:
                "#species-count",

            subspecies:
                "#subspecies-count",

            genera:
                "#genus-count",

            families:
                "#family-count",

            orders:
                "#order-count",

            classes:
                "#class-count",

            phyla:
                "#phylum-count",

            kingdoms:
                "#kingdom-count",

            records_archived:
                "#records-count",

            source_assertions:
                "#assertions-count",

            synonyms:
                "#synonyms-count",

            unresolved_conflicts:
                "#conflicts-count",

            volumes:
                "#volumes-count",

            providers:
                "#providers-count",

            enabled_providers:
                "#enabled-providers-count",

            eligible_providers:
                "#eligible-providers-count",

            last_updated:
                "#updated-date"
        });

    const ALIASES =
        Object.freeze({
            updated:
                "last_updated",

            updated_at:
                "last_updated",

            generated_at:
                "last_updated",

            modified_at:
                "last_updated",

            created_at:
                "last_updated",

            species_count:
                "species",

            subspecies_count:
                "subspecies",

            genus:
                "genera",

            genera_count:
                "genera",

            genus_count:
                "genera",

            family:
                "families",

            families_count:
                "families",

            family_count:
                "families",

            order:
                "orders",

            orders_count:
                "orders",

            order_count:
                "orders",

            class:
                "classes",

            classes_count:
                "classes",

            class_count:
                "classes",

            phylum:
                "phyla",

            phyla_count:
                "phyla",

            phylum_count:
                "phyla",

            kingdom:
                "kingdoms",

            kingdoms_count:
                "kingdoms",

            kingdom_count:
                "kingdoms",

            records:
                "records_archived",

            record_count:
                "records_archived",

            records_count:
                "records_archived",

            canonical_records:
                "records_archived",

            assertions:
                "source_assertions",

            assertion_count:
                "source_assertions",

            assertions_count:
                "source_assertions",

            conflicts:
                "unresolved_conflicts",

            conflict_count:
                "unresolved_conflicts",

            conflicts_count:
                "unresolved_conflicts",

            archive_volumes:
                "volumes",

            volume_count:
                "volumes",

            volumes_count:
                "volumes",

            provider_count:
                "providers",

            registered_providers:
                "providers",

            providers_total:
                "providers",

            providers_count:
                "providers",

            enabled_provider_count:
                "enabled_providers",

            providers_enabled:
                "enabled_providers",

            eligible_provider_count:
                "eligible_providers",

            providers_eligible:
                "eligible_providers"
        });

    const DATE_KEYS =
        new Set([
            "last_updated",
            "updated",
            "updated_at",
            "generated_at",
            "created_at",
            "modified_at"
        ]);

    const PARTIAL_EVENTS =
        Object.freeze([
            "speciedex:includes-loaded",
            "speciedex:include-loaded",
            "speciedex:partials-loaded",
            "speciedex:partial-loaded",
            "speciedex:header-loaded",
            "speciedex:splash-loaded"
        ]);

    const DATA_READY_EVENTS =
        Object.freeze([
            "speciedex:data-ready",
            "speciedex:data-module-available"
        ]);

    /*
    ==========================================================================
    Internal State
    ==========================================================================
    */

    let loadingPromise =
        null;

    let cachedStatistics =
        null;

    let observer =
        null;

    let mutationTimer =
        0;

    let partialTimer =
        0;

    let retryTimer =
        0;

    let retryCount =
        0;

    let initialized =
        false;

    let destroyed =
        false;

    let listenersBound =
        false;

    let lastLoadError =
        null;

    let loadGeneration =
        0;

    let activeAbortController =
        null;

    const activeEvents =
        new Set();

    const partialEventHandlers =
        new Map();

    const dataReadyEventHandlers =
        new Map();

    const boundElements =
        new WeakMap();

    const numberFormatter =
        new Intl.NumberFormat(
            "en-US"
        );

    let easternDateFormatter =
        null;

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function isObject(
        value
    ) {
        return (
            value !==
                null &&
            typeof value ===
                "object" &&
            !Array.isArray(
                value
            )
        );
    }

    function cloneObject(
        value
    ) {
        if (!isObject(value)) {
            return value;
        }

        if (
            typeof structuredClone ===
                "function"
        ) {
            try {
                return structuredClone(
                    value
                );
            } catch (_error) {
                /*
                --------------------------------------------------------------
                Fall through to shallow clone.
                --------------------------------------------------------------
                */
            }
        }

        return {
            ...value
        };
    }

    function normalizeKey(
        value
    ) {
        const key =
            String(
                value || ""
            )
                .trim()
                .toLowerCase()
                .replace(
                    /[\s.-]+/g,
                    "_"
                )
                .replace(
                    /_+/g,
                    "_"
                )
                .replace(
                    /^_+|_+$/g,
                    ""
                );

        return (
            ALIASES[key] ||
            key
        );
    }

    function hasOwn(
        object,
        key
    ) {
        return Object.prototype
            .hasOwnProperty
            .call(
                object,
                key
            );
    }

    function firstDefined(
        object,
        keys
    ) {
        for (
            const key
            of keys
        ) {
            if (
                hasOwn(
                    object,
                    key
                ) &&
                object[key] !==
                    undefined &&
                object[key] !==
                    null &&
                object[key] !==
                    ""
            ) {
                return object[key];
            }
        }

        return undefined;
    }

    function firstNumericValue(
        object,
        keys
    ) {
        for (
            const key
            of keys
        ) {
            if (
                !hasOwn(
                    object,
                    key
                )
            ) {
                continue;
            }

            const value =
                object[key];

            if (
                Array.isArray(
                    value
                ) ||
                isObject(
                    value
                )
            ) {
                continue;
            }

            const numeric =
                Number(
                    value
                );

            if (
                Number.isFinite(
                    numeric
                )
            ) {
                return numeric;
            }
        }

        return null;
    }

    function countCollection(
        value
    ) {
        if (
            Array.isArray(
                value
            )
        ) {
            return value.length;
        }

        if (
            value instanceof
                Map ||
            value instanceof
                Set
        ) {
            return value.size;
        }

        if (
            isObject(
                value
            )
        ) {
            return Object.keys(
                value
            ).length;
        }

        return null;
    }

    function parseDate(
        value
    ) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return null;
        }

        const date =
            value instanceof
                Date
                ? new Date(
                    value.getTime()
                )
                : new Date(
                    value
                );

        return Number.isNaN(
            date.getTime()
        )
            ? null
            : date;
    }

    function getEasternDateFormatter() {
        if (easternDateFormatter) {
            return easternDateFormatter;
        }

        try {
            easternDateFormatter =
                new Intl.DateTimeFormat(
                    "en-US",
                    {
                        timeZone:
                            DISPLAY_TIME_ZONE,

                        year:
                            "numeric",

                        month:
                            "short",

                        day:
                            "2-digit",

                        hour:
                            "numeric",

                        minute:
                            "2-digit",

                        second:
                            "2-digit",

                        timeZoneName:
                            "short"
                    }
                );
        } catch (_error) {
            easternDateFormatter =
                null;
        }

        return easternDateFormatter;
    }

    function dispatchStatisticsEvent(
        name,
        detail = {}
    ) {
        if (
            destroyed ||
            !name ||
            activeEvents.has(
                name
            )
        ) {
            return false;
        }

        activeEvents.add(
            name
        );

        try {
            return document.dispatchEvent(
                new CustomEvent(
                    name,
                    {
                        detail
                    }
                )
            );
        } catch (_error) {
            return false;
        } finally {
            activeEvents.delete(
                name
            );
        }
    }

    /*
    ==========================================================================
    Data Resolution and Validation
    ==========================================================================
    */

    function requireObject(
        data,
        label
    ) {
        if (
            Speciedex.Data &&
            typeof Speciedex.Data
                .requireObject ===
                "function"
        ) {
            Speciedex.Data
                .requireObject(
                    data,
                    label
                );

            return data;
        }

        if (
            !isObject(
                data
            )
        ) {
            throw new TypeError(
                `${label} must be an object.`
            );
        }

        return data;
    }

    function validateStatisticsData(
        data
    ) {
        requireObject(
            data,
            "Statistics data"
        );

        return true;
    }

    function validateSourcesData(
        data
    ) {
        requireObject(
            data,
            "Statistics sources data"
        );

        return true;
    }

    function unwrapStatisticsObject(
        data
    ) {
        requireObject(
            data,
            "Statistics data"
        );

        const candidates = [
            data.statistics,
            data.stats,
            data.data,
            data.summary,
            data
        ];

        for (
            const candidate
            of candidates
        ) {
            if (
                isObject(
                    candidate
                )
            ) {
                return candidate;
            }
        }

        return data;
    }

    function normalizeStatisticsObject(
        data
    ) {
        const source =
            unwrapStatisticsObject(
                data
            );

        const normalized = {};

        for (
            const [
                rawKey,
                value
            ]
            of Object.entries(
                source
            )
        ) {
            const key =
                normalizeKey(
                    rawKey
                );

            if (!key) {
                continue;
            }

            normalized[key] =
                value;
        }

        const rankContainers = [
            source.ranks,
            source.taxonomy,
            source.counts,
            source.taxa
        ];

        for (
            const container
            of rankContainers
        ) {
            if (
                !isObject(
                    container
                )
            ) {
                continue;
            }

            for (
                const [
                    rawKey,
                    value
                ]
                of Object.entries(
                    container
                )
            ) {
                const key =
                    normalizeKey(
                        rawKey
                    );

                if (
                    key &&
                    normalized[key] ===
                        undefined
                ) {
                    normalized[key] =
                        value;
                }
            }
        }

        if (
            normalized.last_updated ===
                undefined
        ) {
            normalized.last_updated =
                firstDefined(
                    source,
                    [
                        "last_updated",
                        "updated",
                        "updated_at",
                        "generated_at",
                        "modified_at",
                        "created_at"
                    ]
                );
        }

        return normalized;
    }

    async function waitForDataModule() {
        if (
            Speciedex.Data &&
            typeof Speciedex.Data
                .fetchJSON ===
                "function"
        ) {
            retryCount =
                0;

            return Speciedex.Data;
        }

        if (destroyed) {
            throw new Error(
                "Speciedex statistics module was destroyed."
            );
        }

        if (
            retryCount >=
                RETRY_LIMIT
        ) {
            throw new Error(
                "Speciedex Data module is unavailable."
            );
        }

        retryCount +=
            1;

        await new Promise(
            (resolve, reject) => {
                const complete =
                    callback => {
                        if (retryTimer) {
                            window.clearTimeout(
                                retryTimer
                            );

                            retryTimer =
                                0;
                        }

                        callback();
                    };

                retryTimer =
                    window.setTimeout(
                        () => {
                            complete(
                                resolve
                            );
                        },
                        RETRY_DELAY
                    );

                if (destroyed) {
                    complete(
                        () => reject(
                            new Error(
                                "Speciedex statistics module was destroyed."
                            )
                        )
                    );
                }
            }
        );

        return waitForDataModule();
    }

    async function loadStatisticsData(
        options = {}
    ) {
        const dataModule =
            await waitForDataModule();

        const force =
            options.force ===
                true;

        const statistics =
            await dataModule
                .fetchJSON(
                    DATA_FILE,
                    {
                        cache:
                            true,

                        refresh:
                            force,

                        requestCache:
                            force
                                ? "no-store"
                                : "no-cache",

                        validate:
                            validateStatisticsData,

                        signal:
                            options.signal
                    }
                );

        let sources =
            null;

        try {
            sources =
                await dataModule
                    .fetchJSON(
                        SOURCES_FILE,
                        {
                            cache:
                                true,

                            refresh:
                                force,

                            requestCache:
                                force
                                    ? "no-store"
                                    : "no-cache",

                            validate:
                                validateSourcesData,

                            signal:
                                options.signal
                        }
                    );
        } catch (error) {
            /*
            ------------------------------------------------------------------
            statistics-sources.json is optional. A missing or malformed
            sources file must not prevent the primary statistics from loading.
            ------------------------------------------------------------------
            */
            console.warn(
                `Unable to load optional ${SOURCES_FILE}:`,
                error
            );
        }

        return mergeStatistics(
            normalizeStatisticsObject(
                statistics
            ),
            sources
        );
    }

    /*
    ==========================================================================
    Provider Metadata
    ==========================================================================
    */

    function extractProviderMetadata(
        data
    ) {
        const result = {
            providers:
                null,

            enabled_providers:
                null,

            eligible_providers:
                null
        };

        if (
            !isObject(
                data
            )
        ) {
            return result;
        }

        const candidates = [
            data,
            data.data,
            data.statistics,
            data.summary,
            data.providers_summary
        ].filter(
            isObject
        );

        for (
            const candidate
            of candidates
        ) {
            if (
                result.providers ===
                    null
            ) {
                result.providers =
                    firstNumericValue(
                        candidate,
                        [
                            "provider_count",
                            "providers_total",
                            "registered_providers",
                            "providers_count",
                            "providers"
                        ]
                    );
            }

            if (
                result.enabled_providers ===
                    null
            ) {
                result.enabled_providers =
                    firstNumericValue(
                        candidate,
                        [
                            "enabled_providers",
                            "enabled_provider_count",
                            "providers_enabled"
                        ]
                    );
            }

            if (
                result.eligible_providers ===
                    null
            ) {
                result.eligible_providers =
                    firstNumericValue(
                        candidate,
                        [
                            "eligible_providers",
                            "eligible_provider_count",
                            "providers_eligible"
                        ]
                    );
            }
        }

        if (
            result.providers ===
                null
        ) {
            for (
                const candidate
                of candidates
            ) {
                result.providers =
                    countCollection(
                        candidate.providers
                    ) ??
                    countCollection(
                        candidate.sources
                    ) ??
                    countCollection(
                        candidate.provider_statistics
                    ) ??
                    countCollection(
                        candidate.provider_counts
                    );

                if (
                    result.providers !==
                        null
                ) {
                    break;
                }
            }
        }

        if (
            result.enabled_providers ===
                null
        ) {
            const providers =
                candidates
                    .map(
                        candidate =>
                            candidate.providers
                    )
                    .find(
                        Array.isArray
                    );

            if (providers) {
                result.enabled_providers =
                    providers.filter(
                        provider =>
                            provider &&
                            provider.enabled !==
                                false &&
                            provider.disabled !==
                                true
                    ).length;
            }
        }

        if (
            result.eligible_providers ===
                null
        ) {
            const providers =
                candidates
                    .map(
                        candidate =>
                            candidate.providers
                    )
                    .find(
                        Array.isArray
                    );

            if (providers) {
                result.eligible_providers =
                    providers.filter(
                        provider =>
                            provider &&
                            (
                                provider.eligible ===
                                    true ||
                                provider.executable ===
                                    true ||
                                provider.available ===
                                    true
                            )
                    ).length;
            }
        }

        return result;
    }

    function mergeStatistics(
        statistics,
        sources
    ) {
        const merged = {
            ...statistics
        };

        const providerMetadata =
            extractProviderMetadata(
                sources
            );

        for (
            const [
                key,
                value
            ]
            of Object.entries(
                providerMetadata
            )
        ) {
            if (
                value !==
                    null &&
                (
                    merged[key] ===
                        undefined ||
                    merged[key] ===
                        null ||
                    merged[key] ===
                        ""
                )
            ) {
                merged[key] =
                    value;
            }
        }

        return merged;
    }

    /*
    ==========================================================================
    Resolve Elements
    ==========================================================================
    */

    function resolveStatisticKey(
        value
    ) {
        return normalizeKey(
            value
        );
    }

    function getStatisticElements(
        root = document
    ) {
        const bindings =
            new Map();

        if (
            !root ||
            typeof root.querySelector !==
                "function"
        ) {
            return bindings;
        }

        for (
            const [
                key,
                selector
            ]
            of Object.entries(
                SELECTORS
            )
        ) {
            if (
                root instanceof Element &&
                root.matches(
                    selector
                )
            ) {
                bindings.set(
                    root,
                    key
                );
            }

            root.querySelectorAll(
                selector
            ).forEach(
                element => {
                    bindings.set(
                        element,
                        key
                    );
                }
            );
        }

        root.querySelectorAll(
            "[data-stat]"
        ).forEach(
            element => {
                const key =
                    resolveStatisticKey(
                        element.dataset.stat
                    );

                if (key) {
                    bindings.set(
                        element,
                        key
                    );
                }
            }
        );

        /*
        ----------------------------------------------------------------------
        When root itself is an inserted statistic element, querySelectorAll
        does not include it.
        ----------------------------------------------------------------------
        */
        if (
            root instanceof
                Element &&
            root.matches(
                "[data-stat]"
            )
        ) {
            const key =
                resolveStatisticKey(
                    root.dataset.stat
                );

            if (key) {
                bindings.set(
                    root,
                    key
                );
            }
        }

        return bindings;
    }

    /*
    ==========================================================================
    Formatting
    ==========================================================================
    */

    function fallbackFormatNumber(
        value
    ) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return "Unavailable";
        }

        const numeric =
            Number(
                value
            );

        if (
            !Number.isFinite(
                numeric
            )
        ) {
            return String(
                value
            );
        }

        if (
            Speciedex.Data &&
            typeof Speciedex.Data
                .formatNumber ===
                "function"
        ) {
            try {
                return Speciedex.Data
                    .formatNumber(
                        numeric
                    );
            } catch (error) {
                console.warn(
                    "Shared number formatter failed:",
                    error
                );
            }
        }

        return numberFormatter
            .format(
                numeric
            );
    }

    function formatStatisticValue(
        value
    ) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return "Unavailable";
        }

        if (
            typeof value ===
                "boolean"
        ) {
            return value
                ? "Yes"
                : "No";
        }

        if (
            typeof value ===
                "number"
        ) {
            return fallbackFormatNumber(
                value
            );
        }

        if (
            typeof value ===
                "string"
        ) {
            const trimmed =
                value.trim();

            if (!trimmed) {
                return "Unavailable";
            }

            const normalizedNumber =
                trimmed.replace(
                    /,/g,
                    ""
                );

            const numeric =
                Number(
                    normalizedNumber
                );

            if (
                Number.isFinite(
                    numeric
                )
            ) {
                return fallbackFormatNumber(
                    numeric
                );
            }

            return trimmed;
        }

        if (
            Array.isArray(
                value
            )
        ) {
            return fallbackFormatNumber(
                value.length
            );
        }

        if (
            value instanceof
                Map ||
            value instanceof
                Set
        ) {
            return fallbackFormatNumber(
                value.size
            );
        }

        if (
            isObject(
                value
            )
        ) {
            const explicit =
                firstDefined(
                    value,
                    [
                        "count",
                        "total",
                        "value"
                    ]
                );

            if (
                explicit !==
                    undefined
            ) {
                return formatStatisticValue(
                    explicit
                );
            }

            return fallbackFormatNumber(
                Object.keys(
                    value
                ).length
            );
        }

        return String(
            value
        );
    }

    function fallbackFormatDate(
        value
    ) {
        const date =
            parseDate(
                value
            );

        if (!date) {
            return value
                ? String(
                    value
                )
                : "Unavailable";
        }

        try {
            return date.toLocaleString(
                "en-US",
                {
                    year:
                        "numeric",

                    month:
                        "short",

                    day:
                        "2-digit",

                    hour:
                        "numeric",

                    minute:
                        "2-digit",

                    second:
                        "2-digit",

                    timeZone:
                        DISPLAY_TIME_ZONE,

                    timeZoneName:
                        "short"
                }
            );
        } catch (_error) {
            return date.toISOString();
        }
    }

    function formatEasternDate(
        value
    ) {
        const date =
            parseDate(
                value
            );

        if (!date) {
            return value
                ? String(
                    value
                )
                : "Unavailable";
        }

        const formatter =
            getEasternDateFormatter();

        if (!formatter) {
            return fallbackFormatDate(
                date
            );
        }

        try {
            return formatter.format(
                date
            );
        } catch (error) {
            console.warn(
                "Unable to format timestamp "
                + `using ${DISPLAY_TIME_ZONE}:`,
                error
            );

            return fallbackFormatDate(
                date
            );
        }
    }

    /*
    ==========================================================================
    Populate Statistics
    ==========================================================================
    */

    function setStatistic(
        element,
        value
    ) {
        if (!element) {
            return false;
        }

        const formatted =
            formatStatisticValue(
                value
            );

        if (
            element.textContent !==
                formatted
        ) {
            element.textContent =
                formatted;
        }

        element.dataset.statStatus =
            formatted ===
                "Unavailable"
                ? "unavailable"
                : "loaded";

        boundElements.set(
            element,
            formatted
        );

        return formatted !==
            "Unavailable";
    }

    function setStatisticDate(
        element,
        value
    ) {
        if (!element) {
            return false;
        }

        const formatted =
            formatEasternDate(
                value
            );

        if (
            element.textContent !==
                formatted
        ) {
            element.textContent =
                formatted;
        }

        element.dataset.statStatus =
            formatted ===
                "Unavailable"
                ? "unavailable"
                : "loaded";

        boundElements.set(
            element,
            formatted
        );

        return formatted !==
            "Unavailable";
    }

    function setStatisticUnavailable(
        element,
        status =
            "unavailable"
    ) {
        if (!element) {
            return false;
        }

        if (
            element.textContent !==
                "Unavailable"
        ) {
            element.textContent =
                "Unavailable";
        }

        element.dataset.statStatus =
            status;

        boundElements.set(
            element,
            "Unavailable"
        );

        return true;
    }

    function setStatisticsUnavailable(
        bindings,
        status =
            "error"
    ) {
        if (
            bindings instanceof
                Map
        ) {
            for (
                const element
                of bindings.keys()
            ) {
                setStatisticUnavailable(
                    element,
                    status
                );
            }

            return;
        }

        if (
            Array.isArray(
                bindings
            )
        ) {
            for (
                const element
                of bindings
            ) {
                setStatisticUnavailable(
                    element,
                    status
                );
            }
        }
    }

    function populateStatistics(
        bindings,
        data
    ) {
        if (
            !(bindings instanceof
                Map) ||
            !isObject(
                data
            )
        ) {
            return {
                updated:
                    0,

                unavailable:
                    0
            };
        }

        let updated =
            0;

        let unavailable =
            0;

        for (
            const [
                element,
                key
            ]
            of bindings.entries()
        ) {
            const value =
                data[key];

            const loaded =
                DATE_KEYS.has(
                    key
                )
                    ? setStatisticDate(
                        element,
                        value
                    )
                    : setStatistic(
                        element,
                        value
                    );

            if (loaded) {
                updated +=
                    1;
            } else {
                unavailable +=
                    1;
            }
        }

        return {
            updated,
            unavailable
        };
    }

    /*
    ==========================================================================
    Initialization and Refresh
    ==========================================================================
    */

    async function initializeStatistics(
        options = {}
    ) {
        if (destroyed) {
            return null;
        }

        const bindings =
            getStatisticElements();

        if (!bindings.size) {
            return cachedStatistics;
        }

        const force =
            options.force ===
                true;

        if (
            cachedStatistics &&
            !force
        ) {
            const summary =
                populateStatistics(
                    bindings,
                    cachedStatistics
                );

            dispatchStatisticsEvent(
                "speciedex:statistics-loaded",
                {
                    elements:
                        Array.from(
                            bindings.keys()
                        ),

                    data:
                        cloneObject(
                            cachedStatistics
                        ),

                    cached:
                        true,

                    summary
                }
            );

            return cachedStatistics;
        }

        if (
            loadingPromise &&
            !force
        ) {
            const data =
                await loadingPromise;

            populateStatistics(
                getStatisticElements(),
                data
            );

            return data;
        }

        const generation =
            ++loadGeneration;

        dispatchStatisticsEvent(
            "speciedex:statistics-loading",
            {
                elements:
                    Array.from(
                        bindings.keys()
                    ),

                force
            }
        );

        if (
            force &&
            activeAbortController
        ) {
            activeAbortController.abort();
        }

        const controller =
            typeof AbortController ===
                "function"
                ? new AbortController()
                : null;

        activeAbortController =
            controller;

        const request =
            loadStatisticsData({
                ...options,
                signal:
                    options.signal ||
                    controller?.signal
            });

        loadingPromise =
            request;

        try {
            const data =
                await request;

            if (
                destroyed ||
                generation !==
                    loadGeneration
            ) {
                return data;
            }

            cachedStatistics =
                data;

            lastLoadError =
                null;

            retryCount =
                0;

            const currentBindings =
                getStatisticElements();

            const summary =
                populateStatistics(
                    currentBindings,
                    data
                );

            initialized =
                true;

            dispatchStatisticsEvent(
                "speciedex:statistics-loaded",
                {
                    elements:
                        Array.from(
                            currentBindings.keys()
                        ),

                    data:
                        cloneObject(
                            data
                        ),

                    cached:
                        false,

                    summary
                }
            );

            return data;
        } catch (error) {
            if (
                generation !==
                    loadGeneration ||
                destroyed ||
                error?.name ===
                    "AbortError"
            ) {
                return null;
            }

            lastLoadError =
                error;

            console.error(
                `Unable to load ${DATA_FILE}:`,
                error
            );

            const currentBindings =
                getStatisticElements();

            setStatisticsUnavailable(
                currentBindings,
                "error"
            );

            dispatchStatisticsEvent(
                "speciedex:statistics-error",
                {
                    elements:
                        Array.from(
                            currentBindings.keys()
                        ),

                    error: {
                        name:
                            error?.name ||
                            "Error",

                        message:
                            error?.message ||
                            String(
                                error
                            )
                    }
                }
            );

            return null;
        } finally {
            if (
                loadingPromise ===
                    request
            ) {
                loadingPromise =
                    null;
            }

            if (
                activeAbortController ===
                    controller
            ) {
                activeAbortController =
                    null;
            }
        }
    }

    async function refreshStatistics() {
        loadGeneration +=
            1;

        if (
            Speciedex.Data &&
            typeof Speciedex.Data
                .clearCache ===
                "function"
        ) {
            try {
                Speciedex.Data
                    .clearCache(
                        DATA_FILE
                    );
            } catch (_error) {
                /*
                --------------------------------------------------------------
                Continue even when one cache entry cannot be cleared.
                --------------------------------------------------------------
                */
            }

            try {
                Speciedex.Data
                    .clearCache(
                        SOURCES_FILE
                    );
            } catch (_error) {
                /*
                --------------------------------------------------------------
                Optional source cache.
                --------------------------------------------------------------
                */
            }
        }

        cachedStatistics =
            null;

        activeAbortController?.abort();

        return initializeStatistics({
            force:
                true
        });
    }

    /*
    ==========================================================================
    Partial and DOM Insertion Support
    ==========================================================================
    */

    function scheduleInitialization(
        delay =
            PARTIAL_DEBOUNCE
    ) {
        if (
            destroyed
        ) {
            return;
        }

        if (
            partialTimer
        ) {
            window.clearTimeout(
                partialTimer
            );
        }

        partialTimer =
            window.setTimeout(
                () => {
                    partialTimer =
                        0;

                    initializeStatistics()
                        .catch(
                            error => {
                                console.error(
                                    "Unable to initialize "
                                    + "Speciedex statistics:",
                                    error
                                );
                            }
                        );
                },
                delay
            );
    }

    function bindPartialEvents() {
        if (
            listenersBound
        ) {
            return;
        }

        listenersBound =
            true;

        for (
            const eventName
            of PARTIAL_EVENTS
        ) {
            const handler =
                () => {
                    scheduleInitialization(
                        PARTIAL_DEBOUNCE
                    );
                };

            partialEventHandlers.set(
                eventName,
                handler
            );

            document.addEventListener(
                eventName,
                handler
            );
        }

        for (
            const eventName
            of DATA_READY_EVENTS
        ) {
            const handler =
                () => {
                    retryCount =
                        0;

                    scheduleInitialization(
                        0
                    );
                };

            dataReadyEventHandlers.set(
                eventName,
                handler
            );

            document.addEventListener(
                eventName,
                handler
            );
        }
    }

    function unbindPartialEvents() {
        if (!listenersBound) {
            return;
        }

        listenersBound =
            false;

        for (
            const [
                eventName,
                handler
            ]
            of partialEventHandlers
        ) {
            document.removeEventListener(
                eventName,
                handler
            );
        }

        for (
            const [
                eventName,
                handler
            ]
            of dataReadyEventHandlers
        ) {
            document.removeEventListener(
                eventName,
                handler
            );
        }

        partialEventHandlers.clear();
        dataReadyEventHandlers.clear();
    }

    function nodeContainsStatistics(
        node
    ) {
        if (
            !(
                node instanceof
                    Element
            )
        ) {
            return false;
        }

        if (
            node.matches(
                "[data-stat]"
            )
        ) {
            return true;
        }

        for (
            const selector
            of Object.values(
                SELECTORS
            )
        ) {
            if (
                node.matches(
                    selector
                ) ||
                node.querySelector(
                    selector
                )
            ) {
                return true;
            }
        }

        return Boolean(
            node.querySelector(
                "[data-stat]"
            )
        );
    }

    function observeStatisticElements() {
        if (
            observer ||
            typeof MutationObserver ===
                "undefined"
        ) {
            return observer;
        }

        observer =
            new MutationObserver(
                mutations => {
                    let found =
                        false;

                    for (
                        const mutation
                        of mutations
                    ) {
                        if (
                            mutation.type ===
                                "attributes" &&
                            mutation.target instanceof
                                Element &&
                            (
                                mutation.attributeName ===
                                    "data-stat" ||
                                mutation.attributeName ===
                                    "id"
                            )
                        ) {
                            found =
                                true;

                            break;
                        }

                        for (
                            const node
                            of mutation.addedNodes
                        ) {
                            if (
                                nodeContainsStatistics(
                                    node
                                )
                            ) {
                                found =
                                    true;

                                break;
                            }
                        }

                        if (found) {
                            break;
                        }
                    }

                    if (!found) {
                        return;
                    }

                    if (
                        mutationTimer
                    ) {
                        window.clearTimeout(
                            mutationTimer
                        );
                    }

                    mutationTimer =
                        window.setTimeout(
                            () => {
                                mutationTimer =
                                    0;

                                initializeStatistics()
                                    .catch(
                                        error => {
                                            console.error(
                                                "Unable to initialize "
                                                + "statistics after "
                                                + "DOM insertion:",
                                                error
                                            );
                                        }
                                    );
                            },
                            MUTATION_DEBOUNCE
                        );
                }
            );

        observer.observe(
            document.documentElement,
            {
                childList:
                    true,

                subtree:
                    true,

                attributes:
                    true,

                attributeFilter: [
                    "data-stat",
                    "id"
                ]
            }
        );

        Speciedex.statisticsObserver =
            observer;

        return observer;
    }

    /*
    ==========================================================================
    Lifecycle
    ==========================================================================
    */

    function destroyStatistics() {
        if (
            destroyed
        ) {
            return false;
        }

        loadGeneration +=
            1;

        activeAbortController?.abort();
        activeAbortController =
            null;

        if (
            partialTimer
        ) {
            window.clearTimeout(
                partialTimer
            );

            partialTimer =
                0;
        }

        if (
            mutationTimer
        ) {
            window.clearTimeout(
                mutationTimer
            );

            mutationTimer =
                0;
        }

        if (
            retryTimer
        ) {
            window.clearTimeout(
                retryTimer
            );

            retryTimer =
                0;
        }

        observer?.disconnect?.();

        observer =
            null;

        Speciedex.statisticsObserver =
            null;

        unbindPartialEvents();

        loadingPromise =
            null;

        dispatchStatisticsEvent(
            "speciedex:statistics-destroyed",
            {
                version:
                    VERSION
            }
        );

        destroyed =
            true;

        return true;
    }

    function status() {
        return {
            name:
                MODULE_NAME,

            version:
                VERSION,

            initialized,

            destroyed,

            loading:
                Boolean(
                    loadingPromise
                ),

            cached:
                Boolean(
                    cachedStatistics
                ),

            elements:
                getStatisticElements()
                    .size,

            retryCount,

            observing:
                Boolean(
                    observer
                ),

            listenersBound,

            lastError:
                lastLoadError
                    ? {
                        name:
                            lastLoadError.name ||
                            "Error",

                        message:
                            lastLoadError.message ||
                            String(
                                lastLoadError
                            )
                    }
                    : null
        };
    }

    function bindInitialStatistics() {
        const initialize =
            () => {
                scheduleInitialization(
                    0
                );
            };

        if (
            document.readyState ===
                "loading"
        ) {
            document.addEventListener(
                "DOMContentLoaded",
                initialize,
                {
                    once:
                        true
                }
            );
        } else {
            initialize();
        }
    }

    /*
    ==========================================================================
    Public API
    ==========================================================================
    */

    const StatisticsAPI =
        Object.freeze({
            name:
                MODULE_NAME,

            version:
                VERSION,

            initialize:
                initializeStatistics,

            refresh:
                refreshStatistics,

            destroy:
                destroyStatistics,

            status,

            getElements:
                getStatisticElements,

            get:
                () => {
                    if (
                        !cachedStatistics
                    ) {
                        return null;
                    }

                    return cloneObject(
                        cachedStatistics
                    );
                },

            setStatistic,

            setStatisticDate,

            formatStatisticValue,

            formatStatisticDate:
                formatEasternDate,

            resolveStatisticKey,

            mergeStatistics,

            extractProviderMetadata
        });

    Speciedex.Statistics =
        StatisticsAPI;

    Speciedex.initializeStatistics =
        initializeStatistics;

    Speciedex.refreshStatistics =
        refreshStatistics;

    Speciedex.destroyStatistics =
        destroyStatistics;

    Speciedex.setStatistic =
        setStatistic;

    Speciedex.setStatisticDate =
        setStatisticDate;

    Speciedex.formatStatisticDate =
        formatEasternDate;

    Speciedex.getStatisticElements =
        getStatisticElements;

    Speciedex.getStatistics =
        StatisticsAPI.get;

    Speciedex.getStatisticsStatus =
        status;

    /*
    ==========================================================================
    Module Startup
    ==========================================================================
    */

    bindPartialEvents();

    observeStatisticElements();

    bindInitialStatistics();

    dispatchStatisticsEvent(
        "speciedex:statistics-module-available",
        {
            module:
                StatisticsAPI,

            version:
                VERSION
        }
    );
})();
