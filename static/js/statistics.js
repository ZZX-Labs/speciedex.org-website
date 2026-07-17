"use strict";

/*
==============================================================================
Speciedex.org
Statistics Module
==============================================================================

Loaded by:

    /static/js/script.js

Responsibilities:

    • Load statistics.json
    • Populate statistics placeholders
    • Format numbers
    • Format dates
    • Gracefully handle unavailable data
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

    const DATA_URL =
        "/static/data/statistics.json";

    const SELECTORS = {
        species: "#species-count",
        kingdoms: "#kingdom-count",
        genera: "#genus-count",
        families: "#family-count",
        updated: "#updated-date"
    };

    /*
    --------------------------------------------------------------------------
    Initialize statistics.
    --------------------------------------------------------------------------
    */

    async function initializeStatistics() {

        const elements = {
            species: document.querySelector(
                SELECTORS.species
            ),

            kingdoms: document.querySelector(
                SELECTORS.kingdoms
            ),

            genera: document.querySelector(
                SELECTORS.genera
            ),

            families: document.querySelector(
                SELECTORS.families
            ),

            updated: document.querySelector(
                SELECTORS.updated
            )
        };

        if (
            !Object.values(elements)
                .some(Boolean)
        ) {
            return;
        }

        try {

            const response =
                await fetch(
                    DATA_URL,
                    {
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
                throw new Error(
                    `HTTP ${response.status}: ${response.url}`
                );
            }

            const data =
                await response.json();

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

            setStatistic(
                elements.updated,
                formatDate(
                    data.last_updated
                ),
                false
            );

        } catch (error) {

            console.error(
                `Unable to load ${DATA_URL}:`,
                error
            );

            Object.values(elements)
                .forEach((element) => {

                    if (!element) {
                        return;
                    }

                    element.textContent =
                        "Unavailable";
                });
        }
    }

    /*
    --------------------------------------------------------------------------
    Populate one statistic.
    --------------------------------------------------------------------------
    */

    function setStatistic(
        element,
        value,
        formatNumber = true
    ) {

        if (!element) {
            return;
        }

        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {

            element.textContent =
                "Unavailable";

            return;
        }

        if (
            formatNumber &&
            Number.isFinite(
                Number(value)
            )
        ) {

            element.textContent =
                Number(value)
                    .toLocaleString(
                        "en-US"
                    );

            return;
        }

        element.textContent =
            String(value);
    }

    /*
    --------------------------------------------------------------------------
    Format ISO dates.
    --------------------------------------------------------------------------
    */

    function formatDate(value) {

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
    --------------------------------------------------------------------------
    Public API.
    --------------------------------------------------------------------------
    */

    Speciedex.initializeStatistics =
        initializeStatistics;

    Speciedex.setStatistic =
        setStatistic;

    Speciedex.formatStatisticDate =
        formatDate;

})();
