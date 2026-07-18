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
    • Validate the expected statistics structure
    • Populate statistics placeholders
    • Format numbers and dates consistently
    • Gracefully handle unavailable data
    • Dispatch statistics lifecycle events

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

    const DATA_FILE =
        "statistics.json";

    const SELECTORS = Object.freeze({
        species:
            "#species-count",

        kingdoms:
            "#kingdom-count",

        genera:
            "#genus-count",

        families:
            "#family-count",

        updated:
            "#updated-date"
    });

    let initialized = false;

    /*
    ==========================================================================
    Resolve Elements
    ==========================================================================
    */

    function getStatisticElements() {
        return {
            species:
                document.querySelector(
                    SELECTORS.species
                ),

            kingdoms:
                document.querySelector(
                    SELECTORS.kingdoms
                ),

            genera:
                document.querySelector(
                    SELECTORS.genera
                ),

            families:
                document.querySelector(
                    SELECTORS.families
                ),

            updated:
                document.querySelector(
                    SELECTORS.updated
                )
        };
    }

    /*
    ==========================================================================
    Validate Statistics Data
    ==========================================================================
    */

    function validateStatisticsData(
        data
    ) {
        if (
            !Speciedex.Data ||
            typeof Speciedex.Data
                .requireObject !==
                "function"
        ) {
            throw new Error(
                "Speciedex Data module is unavailable."
            );
        }

        Speciedex.Data.requireObject(
            data,
            "Statistics data"
        );

        return true;
    }

    /*
    ==========================================================================
    Initialize Statistics
    ==========================================================================
    */

    async function initializeStatistics() {
        if (initialized) {
            return;
        }

        const elements =
            getStatisticElements();

        if (
            !Object.values(elements)
                .some(Boolean)
        ) {
            return;
        }

        initialized = true;

        dispatchStatisticsEvent(
            "speciedex:statistics-loading",
            {
                elements
            }
        );

        try {
            if (
                !Speciedex.Data ||
                typeof Speciedex.Data
                    .fetchJSON !==
                    "function"
            ) {
                throw new Error(
                    "Speciedex Data module is unavailable."
                );
            }

            const data =
                await Speciedex.Data
                    .fetchJSON(
                        DATA_FILE,
                        {
                            cache: true,
                            requestCache:
                                "no-cache",
                            validate:
                                validateStatisticsData
                        }
                    );

            populateStatistics(
                elements,
                data
            );

            dispatchStatisticsEvent(
                "speciedex:statistics-loaded",
                {
                    elements,
                    data
                }
            );
        } catch (error) {
            initialized = false;

            console.error(
                `Unable to load ${DATA_FILE}:`,
                error
            );

            setStatisticsUnavailable(
                elements
            );

            dispatchStatisticsEvent(
                "speciedex:statistics-error",
                {
                    elements,
                    error
                }
            );
        }
    }

    /*
    ==========================================================================
    Populate Statistics
    ==========================================================================
    */

    function populateStatistics(
        elements,
        data
    ) {
        setStatistic(
            elements.species,
            data.species
        );

        setStatistic(
            elements.kingdoms,
            data.kingdoms
        );

        setStatistic(
            elements.genera,
            data.genera
        );

        setStatistic(
            elements.families,
            data.families
        );

        setStatisticDate(
            elements.updated,
            data.last_updated
        );
    }

    /*
    ==========================================================================
    Set Numeric Statistic
    ==========================================================================
    */

    function setStatistic(
        element,
        value
    ) {
        if (!element) {
            return;
        }

        const formatted =
            Speciedex.Data
                ?.formatNumber
            ? Speciedex.Data
                .formatNumber(
                    value
                )
            : fallbackFormatNumber(
                value
            );

        element.textContent =
            formatted;
    }

    /*
    ==========================================================================
    Set Date Statistic
    ==========================================================================
    */

    function setStatisticDate(
        element,
        value
    ) {
        if (!element) {
            return;
        }

        const formatted =
            Speciedex.Data
                ?.formatDate
            ? Speciedex.Data
                .formatDate(
                    value
                )
            : fallbackFormatDate(
                value
            );

        element.textContent =
            formatted;
    }

    /*
    ==========================================================================
    Unavailable State
    ==========================================================================
    */

    function setStatisticsUnavailable(
        elements
    ) {
        if (
            Speciedex.Data &&
            typeof Speciedex.Data
                .setUnavailable ===
                "function"
        ) {
            Speciedex.Data
                .setUnavailable(
                    elements
                );

            return;
        }

        Object.values(
            elements || {}
        ).forEach(
            (element) => {
                if (element) {
                    element.textContent =
                        "Unavailable";
                }
            }
        );
    }

    /*
    ==========================================================================
    Refresh Statistics
    ==========================================================================
    */

    async function refreshStatistics() {
        if (
            Speciedex.Data &&
            typeof Speciedex.Data
                .clearCache ===
                "function"
        ) {
            Speciedex.Data.clearCache(
                DATA_FILE
            );
        }

        initialized = false;

        return initializeStatistics();
    }

    /*
    ==========================================================================
    Fallback Number Formatting
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

        const number =
            Number(value);

        if (!Number.isFinite(number)) {
            return String(value);
        }

        return number.toLocaleString(
            "en-US"
        );
    }

    /*
    ==========================================================================
    Fallback Date Formatting
    ==========================================================================
    */

    function fallbackFormatDate(
        value
    ) {
        if (!value) {
            return "Unavailable";
        }

        const date =
            new Date(value);

        if (
            Number.isNaN(
                date.getTime()
            )
        ) {
            return String(value);
        }

        return date.toLocaleDateString(
            "en-US",
            {
                year: "numeric",
                month: "long",
                day: "numeric",
                timeZone: "UTC"
            }
        );
    }

    /*
    ==========================================================================
    Lifecycle Events
    ==========================================================================
    */

    function dispatchStatisticsEvent(
        name,
        detail = {}
    ) {
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
    Public API
    ==========================================================================
    */

    Speciedex.initializeStatistics =
        initializeStatistics;

    Speciedex.refreshStatistics =
        refreshStatistics;

    Speciedex.setStatistic =
        setStatistic;

    Speciedex.setStatisticDate =
        setStatisticDate;
})();
