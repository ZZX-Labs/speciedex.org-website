/*
========================================================================
Speciedex.org
Terminal Map Renderer
========================================================================

OpenStreetMap-based tactical biodiversity map renderer for SpeciedexTerminal.

Provides:

    • OpenStreetMap tile rendering with required attribution
    • dark tactical map treatment
    • #c0d674 Speciedex accents and typography
    • world-to-street zoom levels
    • point observations
    • range polygons and multipolygons
    • migration paths
    • seasonal and temporal filtering
    • interpolated movement playback
    • time slider and playback controls
    • clustering-compatible data preparation
    • species and provider filters
    • fit-to-data and focus controls
    • GeoJSON import and export
    • terminal commands

The renderer uses Leaflet when available. If Leaflet is not already present, it
loads Leaflet dynamically from the configured CDN. The default OpenStreetMap
tile endpoint is:

    https://tile.openstreetmap.org/{z}/{x}/{y}.png

OpenStreetMap attribution must remain visible:

    © OpenStreetMap contributors

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME =
        "Map";

    const VERSION =
        "2.0.0";

    const PRIMARY_COLOR =
        "#c0d674";

    const DARK_BACKGROUND =
        "#07100a";

    const PANEL_BACKGROUND =
        "rgba(4, 10, 6, 0.94)";

    const OSM_TILE_URL =
        "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

    const OSM_ATTRIBUTION =
        '&copy; <a href="https://www.openstreetmap.org/copyright" ' +
        'target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>';

    const LEAFLET_JS =
        "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";

    const LEAFLET_CSS =
        "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";

    const DEFAULT_OPTIONS =
        Object.freeze({
            center:
                [20, 0],

            zoom:
                2,

            minZoom:
                1,

            maxZoom:
                19,

            worldCopyJump:
                true,

            preferCanvas:
                true,

            tileURL:
                OSM_TILE_URL,

            attribution:
                OSM_ATTRIBUTION,

            leafletJS:
                LEAFLET_JS,

            leafletCSS:
                LEAFLET_CSS,

            dark:
                true,

            tactical:
                true,

            showControls:
                true,

            showTimeline:
                true,

            showLegend:
                true,

            showGrid:
                true,

            fitBounds:
                true,

            animationSpeed:
                1,

            interpolationStepMinutes:
                30,

            pointRadius:
                5,

            pathWeight:
                2,

            rangeOpacity:
                0.15,

            rangeWeight:
                1.5,

            primaryColor:
                PRIMARY_COLOR,

            backgroundColor:
                DARK_BACKGROUND,

            initialTime:
                null,

            startTime:
                null,

            endTime:
                null
        });

    const OBSERVATION_LAT_FIELDS =
        Object.freeze([
            "lat",
            "latitude",
            "decimalLatitude",
            "decimal_latitude",
            "y"
        ]);

    const OBSERVATION_LON_FIELDS =
        Object.freeze([
            "lon",
            "lng",
            "longitude",
            "decimalLongitude",
            "decimal_longitude",
            "x"
        ]);

    const TIME_FIELDS =
        Object.freeze([
            "timestamp",
            "datetime",
            "date",
            "eventDate",
            "event_date",
            "observed_at",
            "observation_time",
            "time"
        ]);

    const SPECIES_FIELDS =
        Object.freeze([
            "scientific_name",
            "scientificName",
            "canonical_name",
            "canonicalName",
            "accepted_name",
            "acceptedName",
            "species",
            "taxon",
            "name"
        ]);

    const COMMON_NAME_FIELDS =
        Object.freeze([
            "common_name",
            "commonName",
            "vernacular_name",
            "vernacularName"
        ]);

    const ID_FIELDS =
        Object.freeze([
            "speciedex_id",
            "speciedexId",
            "id",
            "key",
            "uuid"
        ]);

    const PROVIDER_FIELDS =
        Object.freeze([
            "provider",
            "source",
            "dataset",
            "institution"
        ]);

    const RANGE_FIELDS =
        Object.freeze([
            "range",
            "geometry",
            "geojson",
            "distribution",
            "polygon"
        ]);

    const PATH_FIELDS =
        Object.freeze([
            "path",
            "track",
            "migration",
            "route",
            "coordinates"
        ]);

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function clamp(
        value,
        minimum,
        maximum
    ) {
        return Math.min(
            maximum,
            Math.max(
                minimum,
                value
            )
        );
    }

    function parseBoolean(
        value,
        fallback = false
    ) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return fallback;
        }

        return ![
            "false",
            "0",
            "no",
            "off"
        ].includes(
            String(value)
                .trim()
                .toLowerCase()
        );
    }

    function parseNumber(
        value,
        fallback = null
    ) {
        const numeric =
            Number(value);

        return Number.isFinite(
            numeric
        )
            ? numeric
            : fallback;
    }

    function parseDate(
        value
    ) {
        if (
            value === null ||
            value === undefined ||
            value === ""
        ) {
            return null;
        }

        if (
            value instanceof
            Date
        ) {
            const timestamp =
                value.getTime();

            return Number.isFinite(
                timestamp
            )
                ? timestamp
                : null;
        }

        const timestamp =
            Date.parse(
                value
            );

        return Number.isFinite(
            timestamp
        )
            ? timestamp
            : null;
    }

    function firstValue(
        record,
        fields
    ) {
        for (const field of fields) {
            const value =
                record?.[
                    field
                ];

            if (
                value !== undefined &&
                value !== null &&
                value !== ""
            ) {
                return value;
            }
        }

        return null;
    }

    function normalizeText(
        value
    ) {
        return String(
            value ?? ""
        ).trim();
    }

    function resolveCoordinates(
        record
    ) {
        if (
            Array.isArray(
                record
            ) &&
            record.length >=
                2
        ) {
            const first =
                parseNumber(
                    record[0]
                );

            const second =
                parseNumber(
                    record[1]
                );

            if (
                first !== null &&
                second !== null
            ) {
                if (
                    Math.abs(first) <=
                        90 &&
                    Math.abs(second) <=
                        180
                ) {
                    return [
                        first,
                        second
                    ];
                }

                if (
                    Math.abs(second) <=
                        90 &&
                    Math.abs(first) <=
                        180
                ) {
                    return [
                        second,
                        first
                    ];
                }
            }
        }

        const latitude =
            parseNumber(
                firstValue(
                    record,
                    OBSERVATION_LAT_FIELDS
                )
            );

        const longitude =
            parseNumber(
                firstValue(
                    record,
                    OBSERVATION_LON_FIELDS
                )
            );

        if (
            latitude === null ||
            longitude === null ||
            Math.abs(latitude) >
                90 ||
            Math.abs(longitude) >
                180
        ) {
            return null;
        }

        return [
            latitude,
            longitude
        ];
    }

    function resolveTimestamp(
        record
    ) {
        return parseDate(
            firstValue(
                record,
                TIME_FIELDS
            )
        );
    }

    function resolveSpecies(
        record
    ) {
        return normalizeText(
            firstValue(
                record,
                SPECIES_FIELDS
            ) ||
            "Unknown species"
        );
    }

    function resolveCommonName(
        record
    ) {
        return normalizeText(
            firstValue(
                record,
                COMMON_NAME_FIELDS
            ) ||
            ""
        );
    }

    function resolveID(
        record,
        index
    ) {
        return normalizeText(
            firstValue(
                record,
                ID_FIELDS
            ) ||
            `record:${index}`
        );
    }

    function resolveProvider(
        record
    ) {
        return normalizeText(
            firstValue(
                record,
                PROVIDER_FIELDS
            ) ||
            "unknown"
        );
    }

    function flattenRecords(
        data
    ) {
        if (
            Array.isArray(data)
        ) {
            return data;
        }

        if (
            data?.type ===
                "FeatureCollection" &&
            Array.isArray(
                data.features
            )
        ) {
            return data.features.map(
                feature => ({
                    ...(feature.properties || {}),
                    geometry:
                        feature.geometry
                })
            );
        }

        if (
            data?.records &&
            Array.isArray(
                data.records
            )
        ) {
            return data.records;
        }

        if (
            data &&
            typeof data ===
            "object"
        ) {
            return [
                data
            ];
        }

        return [];
    }

    function normalizeObservation(
        record,
        index
    ) {
        const coordinates =
            resolveCoordinates(
                record
            );

        if (!coordinates) {
            return null;
        }

        return {
            id:
                resolveID(
                    record,
                    index
                ),

            species:
                resolveSpecies(
                    record
                ),

            commonName:
                resolveCommonName(
                    record
                ),

            provider:
                resolveProvider(
                    record
                ),

            timestamp:
                resolveTimestamp(
                    record
                ),

            latitude:
                coordinates[0],

            longitude:
                coordinates[1],

            record
        };
    }

    function extractGeometry(
        record
    ) {
        const direct =
            firstValue(
                record,
                RANGE_FIELDS
            );

        if (
            direct?.type &&
            direct.coordinates
        ) {
            return direct;
        }

        if (
            record?.type ===
                "Feature" &&
            record.geometry
        ) {
            return record.geometry;
        }

        return null;
    }

    function extractPath(
        record
    ) {
        const direct =
            firstValue(
                record,
                PATH_FIELDS
            );

        if (
            direct?.type ===
                "LineString"
        ) {
            return direct.coordinates;
        }

        if (
            Array.isArray(
                direct
            )
        ) {
            return direct;
        }

        return null;
    }

    function toLeafletLatLngs(
        coordinates
    ) {
        if (!Array.isArray(coordinates)) {
            return [];
        }

        return coordinates.map(
            coordinate => {
                if (
                    Array.isArray(
                        coordinate
                    ) &&
                    coordinate.length >=
                        2 &&
                    typeof coordinate[0] ===
                        "number" &&
                    typeof coordinate[1] ===
                        "number"
                ) {
                    return [
                        coordinate[1],
                        coordinate[0]
                    ];
                }

                return toLeafletLatLngs(
                    coordinate
                );
            }
        );
    }

    function formatDate(
        timestamp
    ) {
        if (
            timestamp === null ||
            timestamp === undefined
        ) {
            return "Undated";
        }

        return new Date(
            timestamp
        ).toISOString();
    }

    function seasonForTimestamp(
        timestamp,
        latitude = 0
    ) {
        if (timestamp === null) {
            return null;
        }

        const month =
            new Date(
                timestamp
            ).getUTCMonth();

        const north =
            latitude >=
            0;

        const seasonIndex =
            month === 11 ||
            month <= 1
                ? 0
                : month <= 4
                    ? 1
                    : month <= 7
                        ? 2
                        : 3;

        const northern = [
            "winter",
            "spring",
            "summer",
            "autumn"
        ];

        const southern = [
            "summer",
            "autumn",
            "winter",
            "spring"
        ];

        return (
            north
                ? northern
                : southern
        )[
            seasonIndex
        ];
    }

    /*
    ==========================================================================
    Dependency Loading
    ==========================================================================
    */

    function findScript(
        url
    ) {
        return Array.from(
            document.scripts
        ).find(
            script =>
                script.src ===
                url
        ) ||
        null;
    }

    function findStyle(
        url
    ) {
        return Array.from(
            document.querySelectorAll(
                'link[rel="stylesheet"]'
            )
        ).find(
            link =>
                link.href ===
                url
        ) ||
        null;
    }

    function loadScript(
        url
    ) {
        const absolute =
            new URL(
                url,
                window.location.href
            ).href;

        if (
            findScript(
                absolute
            )
        ) {
            return Promise.resolve();
        }

        return new Promise(
            (
                resolve,
                reject
            ) => {
                const script =
                    document.createElement(
                        "script"
                    );

                script.src =
                    absolute;

                script.async =
                    true;

                script.addEventListener(
                    "load",
                    () =>
                        resolve(),
                    {
                        once:
                            true
                    }
                );

                script.addEventListener(
                    "error",
                    () =>
                        reject(
                            new Error(
                                `Unable to load map dependency: ${absolute}`
                            )
                        ),
                    {
                        once:
                            true
                    }
                );

                document.head.appendChild(
                    script
                );
            }
        );
    }

    function loadStyle(
        url
    ) {
        const absolute =
            new URL(
                url,
                window.location.href
            ).href;

        if (
            findStyle(
                absolute
            )
        ) {
            return Promise.resolve();
        }

        return new Promise(
            (
                resolve,
                reject
            ) => {
                const link =
                    document.createElement(
                        "link"
                    );

                link.rel =
                    "stylesheet";

                link.href =
                    absolute;

                link.addEventListener(
                    "load",
                    () =>
                        resolve(),
                    {
                        once:
                            true
                    }
                );

                link.addEventListener(
                    "error",
                    () =>
                        reject(
                            new Error(
                                `Unable to load map stylesheet: ${absolute}`
                            )
                        ),
                    {
                        once:
                            true
                    }
                );

                document.head.appendChild(
                    link
                );
            }
        );
    }

    async function ensureLeaflet(
        options
    ) {
        if (
            window.L &&
            typeof window.L.map ===
                "function"
        ) {
            return window.L;
        }

        await Promise.all([
            loadStyle(
                options.leafletCSS
            ),
            loadScript(
                options.leafletJS
            )
        ]);

        if (
            !window.L ||
            typeof window.L.map !==
                "function"
        ) {
            throw new Error(
                "Leaflet failed to initialize."
            );
        }

        return window.L;
    }

    /*
    ==========================================================================
    Styles
    ==========================================================================
    */

    function injectMapStyles() {
        if (
            document.getElementById(
                "speciedex-terminal-map-styles"
            )
        ) {
            return;
        }

        const style =
            document.createElement(
                "style"
            );

        style.id =
            "speciedex-terminal-map-styles";

        style.textContent = `
            .terminal-renderer-map {
                --map-accent: ${PRIMARY_COLOR};
                --map-bg: ${DARK_BACKGROUND};
                position: relative;
                display: grid;
                gap: 0;
                min-height: 32rem;
                overflow: hidden;
                border: 1px solid rgba(192, 214, 116, 0.22);
                background: var(--map-bg);
                color: var(--map-accent);
                font-family:
                    "IBM Plex Mono",
                    ui-monospace,
                    SFMono-Regular,
                    Consolas,
                    monospace;
            }

            .terminal-map-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 1rem;
                padding: 0.7rem 0.9rem;
                border-bottom: 1px solid rgba(192, 214, 116, 0.18);
                background: ${PANEL_BACKGROUND};
            }

            .terminal-map-title {
                margin: 0;
                color: var(--map-accent);
                font-size: 0.95rem;
                letter-spacing: 0.06em;
                text-transform: uppercase;
            }

            .terminal-map-status {
                color: rgba(216, 230, 219, 0.72);
                font-size: 0.72rem;
            }

            .terminal-map-body {
                position: relative;
                min-height: 28rem;
            }

            .terminal-map-canvas {
                position: absolute;
                inset: 0;
                background: var(--map-bg);
            }

            .terminal-map-dark .leaflet-tile-pane {
                filter:
                    grayscale(1)
                    invert(0.92)
                    brightness(0.48)
                    contrast(1.42)
                    sepia(0.32)
                    hue-rotate(48deg)
                    saturate(0.72);
            }

            .terminal-map-dark .leaflet-overlay-pane,
            .terminal-map-dark .leaflet-marker-pane,
            .terminal-map-dark .leaflet-tooltip-pane,
            .terminal-map-dark .leaflet-popup-pane {
                filter: none;
            }

            .terminal-map-grid {
                position: absolute;
                inset: 0;
                z-index: 440;
                pointer-events: none;
                opacity: 0.22;
                background-image:
                    linear-gradient(
                        rgba(192, 214, 116, 0.11) 1px,
                        transparent 1px
                    ),
                    linear-gradient(
                        90deg,
                        rgba(192, 214, 116, 0.11) 1px,
                        transparent 1px
                    );
                background-size: 3rem 3rem;
                mix-blend-mode: screen;
            }

            .terminal-map-controls {
                position: absolute;
                top: 0.75rem;
                right: 0.75rem;
                z-index: 800;
                display: grid;
                gap: 0.45rem;
                width: min(18rem, calc(100% - 1.5rem));
                padding: 0.7rem;
                border: 1px solid rgba(192, 214, 116, 0.24);
                background: ${PANEL_BACKGROUND};
                box-shadow: 0 0 1.2rem rgba(0, 0, 0, 0.45);
            }

            .terminal-map-control-row {
                display: flex;
                align-items: center;
                gap: 0.45rem;
                flex-wrap: wrap;
            }

            .terminal-map-controls button,
            .terminal-map-controls select,
            .terminal-map-controls input {
                border: 1px solid rgba(192, 214, 116, 0.3);
                background: rgba(4, 10, 6, 0.9);
                color: var(--map-accent);
                font: inherit;
                font-size: 0.7rem;
            }

            .terminal-map-controls button {
                padding: 0.34rem 0.5rem;
                cursor: pointer;
            }

            .terminal-map-controls button:hover,
            .terminal-map-controls button:focus-visible {
                background: rgba(192, 214, 116, 0.12);
                outline: none;
            }

            .terminal-map-controls input[type="range"] {
                width: 100%;
                accent-color: var(--map-accent);
            }

            .terminal-map-timeline {
                position: absolute;
                left: 0.75rem;
                right: 0.75rem;
                bottom: 0.75rem;
                z-index: 800;
                display: grid;
                gap: 0.42rem;
                padding: 0.7rem;
                border: 1px solid rgba(192, 214, 116, 0.24);
                background: ${PANEL_BACKGROUND};
            }

            .terminal-map-timeline-header {
                display: flex;
                justify-content: space-between;
                gap: 1rem;
                color: rgba(216, 230, 219, 0.74);
                font-size: 0.68rem;
            }

            .terminal-map-legend {
                position: absolute;
                left: 0.75rem;
                top: 0.75rem;
                z-index: 800;
                max-width: min(18rem, calc(100% - 1.5rem));
                padding: 0.65rem 0.75rem;
                border: 1px solid rgba(192, 214, 116, 0.24);
                background: ${PANEL_BACKGROUND};
                font-size: 0.68rem;
            }

            .terminal-map-legend h4 {
                margin: 0 0 0.45rem;
                color: var(--map-accent);
                font-size: 0.72rem;
                text-transform: uppercase;
            }

            .terminal-map-legend-item {
                display: flex;
                justify-content: space-between;
                gap: 1rem;
                padding: 0.1rem 0;
            }

            .terminal-map-popup {
                min-width: 13rem;
                color: #d8e6db;
                font-family:
                    "IBM Plex Mono",
                    ui-monospace,
                    SFMono-Regular,
                    Consolas,
                    monospace;
                font-size: 0.72rem;
            }

            .terminal-map-popup strong {
                color: ${PRIMARY_COLOR};
            }

            .terminal-map-dark .leaflet-control-zoom a,
            .terminal-map-dark .leaflet-control-attribution {
                border-color: rgba(192, 214, 116, 0.24);
                background: ${PANEL_BACKGROUND};
                color: ${PRIMARY_COLOR};
            }

            .terminal-map-dark .leaflet-control-attribution a {
                color: ${PRIMARY_COLOR};
            }

            .terminal-map-dark .leaflet-popup-content-wrapper,
            .terminal-map-dark .leaflet-popup-tip {
                background: rgba(4, 10, 6, 0.97);
                color: #d8e6db;
                border: 1px solid rgba(192, 214, 116, 0.24);
                border-radius: 0;
            }

            .terminal-map-marker-pulse {
                animation:
                    terminal-map-marker-pulse
                    1.7s ease-in-out infinite;
            }

            @keyframes terminal-map-marker-pulse {
                0%,
                100% {
                    stroke-opacity: 0.7;
                    fill-opacity: 0.62;
                }

                50% {
                    stroke-opacity: 1;
                    fill-opacity: 0.95;
                }
            }

            @media (max-width: 760px) {
                .terminal-map-controls,
                .terminal-map-legend {
                    position: relative;
                    inset: auto;
                    width: auto;
                    max-width: none;
                    margin: 0.5rem;
                    z-index: 900;
                }

                .terminal-map-timeline {
                    left: 0.5rem;
                    right: 0.5rem;
                    bottom: 0.5rem;
                }

                .terminal-map-body {
                    min-height: 36rem;
                }
            }
        `;

        document.head.appendChild(
            style
        );
    }

    /*
    ==========================================================================
    Temporal Model
    ==========================================================================
    */

    class TemporalModel {
        constructor(
            observations = []
        ) {
            this.observations =
                observations
                    .filter(Boolean)
                    .sort(
                        (
                            left,
                            right
                        ) =>
                            (
                                left.timestamp ??
                                Number.NEGATIVE_INFINITY
                            ) -
                            (
                                right.timestamp ??
                                Number.NEGATIVE_INFINITY
                            )
                    );

            this.timestamps =
                this.observations
                    .map(
                        observation =>
                            observation.timestamp
                    )
                    .filter(
                        timestamp =>
                            timestamp !==
                            null
                    );

            this.start =
                this.timestamps.length
                    ? Math.min(
                        ...this.timestamps
                    )
                    : null;

            this.end =
                this.timestamps.length
                    ? Math.max(
                        ...this.timestamps
                    )
                    : null;
        }

        at(
            timestamp,
            windowMilliseconds =
                24 *
                60 *
                60 *
                1000
        ) {
            if (
                timestamp ===
                    null ||
                timestamp ===
                    undefined
            ) {
                return [
                    ...this.observations
                ];
            }

            const minimum =
                timestamp -
                windowMilliseconds /
                2;

            const maximum =
                timestamp +
                windowMilliseconds /
                2;

            return this.observations.filter(
                observation =>
                    observation.timestamp ===
                        null ||
                    (
                        observation.timestamp >=
                            minimum &&
                        observation.timestamp <=
                            maximum
                    )
            );
        }

        seasonal(
            timestamp
        ) {
            if (timestamp === null) {
                return [
                    ...this.observations
                ];
            }

            return this.observations.filter(
                observation => {
                    if (
                        observation.timestamp ===
                        null
                    ) {
                        return true;
                    }

                    return seasonForTimestamp(
                        observation.timestamp,
                        observation.latitude
                    ) ===
                    seasonForTimestamp(
                        timestamp,
                        observation.latitude
                    );
                }
            );
        }

        interpolateTrack(
            observations,
            timestamp
        ) {
            const timed =
                observations
                    .filter(
                        observation =>
                            observation.timestamp !==
                            null
                    )
                    .sort(
                        (
                            left,
                            right
                        ) =>
                            left.timestamp -
                            right.timestamp
                    );

            if (!timed.length) {
                return null;
            }

            if (
                timestamp <=
                timed[0].timestamp
            ) {
                return {
                    latitude:
                        timed[0].latitude,
                    longitude:
                        timed[0].longitude,
                    progress:
                        0,
                    before:
                        timed[0],
                    after:
                        timed[0]
                };
            }

            if (
                timestamp >=
                timed[
                    timed.length -
                    1
                ].timestamp
            ) {
                const last =
                    timed[
                        timed.length -
                        1
                    ];

                return {
                    latitude:
                        last.latitude,
                    longitude:
                        last.longitude,
                    progress:
                        1,
                    before:
                        last,
                    after:
                        last
                };
            }

            for (
                let index = 1;
                index < timed.length;
                index += 1
            ) {
                const before =
                    timed[
                        index -
                        1
                    ];

                const after =
                    timed[
                        index
                    ];

                if (
                    timestamp >=
                        before.timestamp &&
                    timestamp <=
                        after.timestamp
                ) {
                    const duration =
                        after.timestamp -
                        before.timestamp;

                    const progress =
                        duration
                            ? (
                                timestamp -
                                before.timestamp
                            ) /
                            duration
                            : 0;

                    return {
                        latitude:
                            before.latitude +
                            (
                                after.latitude -
                                before.latitude
                            ) *
                            progress,

                        longitude:
                            before.longitude +
                            (
                                after.longitude -
                                before.longitude
                            ) *
                            progress,

                        progress,
                        before,
                        after
                    };
                }
            }

            return null;
        }
    }

    /*
    ==========================================================================
    Tactical Map Controller
    ==========================================================================
    */

    class TacticalMapController
        extends EventTarget {
        constructor(
            container,
            data,
            options = {}
        ) {
            super();

            if (
                !(container instanceof Element)
            ) {
                throw new TypeError(
                    "TacticalMapController requires a container Element."
                );
            }

            this.container =
                container;

            this.options = {
                ...DEFAULT_OPTIONS,
                ...options
            };

            this.records =
                flattenRecords(
                    data
                );

            this.observations =
                this.records
                    .map(
                        normalizeObservation
                    )
                    .filter(Boolean);

            this.temporal =
                new TemporalModel(
                    this.observations
                );

            this.map =
                null;

            this.L =
                null;

            this.layers =
                {};

            this.markers =
                new Map();

            this.migrationMarkers =
                new Map();

            this.playing =
                false;

            this.animationFrame =
                0;

            this.lastFrameTime =
                0;

            this.currentTime =
                parseDate(
                    this.options.initialTime
                ) ??
                this.temporal.start ??
                Date.now();

            this.timeWindow =
                24 *
                60 *
                60 *
                1000;

            this.temporalMode =
                "window";

            this.speciesFilter =
                null;

            this.providerFilter =
                null;

            this.destroyed =
                false;

            injectMapStyles();

            this.buildShell();
        }

        /*
        ======================================================================
        DOM
        ======================================================================
        */

        buildShell() {
            this.container.replaceChildren();

            this.container.classList.add(
                "terminal-renderer",
                "terminal-renderer-map"
            );

            this.container.dataset.renderer =
                "map";

            this.container.style.setProperty(
                "--map-accent",
                this.options.primaryColor
            );

            const header =
                document.createElement(
                    "header"
                );

            header.className =
                "terminal-map-header";

            const title =
                document.createElement(
                    "h3"
                );

            title.className =
                "terminal-map-title";

            title.textContent =
                this.options.title ||
                "Speciedex Tactical Range Map";

            const status =
                document.createElement(
                    "span"
                );

            status.className =
                "terminal-map-status";

            status.dataset.mapStatus =
                "";

            status.textContent =
                "Initializing OpenStreetMap";

            header.append(
                title,
                status
            );

            const body =
                document.createElement(
                    "div"
                );

            body.className =
                "terminal-map-body";

            const canvas =
                document.createElement(
                    "div"
                );

            canvas.className =
                "terminal-map-canvas";

            canvas.dataset.mapCanvas =
                "";

            body.appendChild(
                canvas
            );

            if (
                this.options.showGrid
            ) {
                const grid =
                    document.createElement(
                        "div"
                    );

                grid.className =
                    "terminal-map-grid";

                grid.setAttribute(
                    "aria-hidden",
                    "true"
                );

                body.appendChild(
                    grid
                );
            }

            if (
                this.options.showLegend
            ) {
                body.appendChild(
                    this.createLegend()
                );
            }

            if (
                this.options.showControls
            ) {
                body.appendChild(
                    this.createControls()
                );
            }

            if (
                this.options.showTimeline
            ) {
                body.appendChild(
                    this.createTimeline()
                );
            }

            this.container.append(
                header,
                body
            );

            this.elements = {
                header,
                title,
                status,
                body,
                canvas,
                legend:
                    body.querySelector(
                        "[data-map-legend]"
                    ),
                controls:
                    body.querySelector(
                        "[data-map-controls]"
                    ),
                timeline:
                    body.querySelector(
                        "[data-map-timeline]"
                    ),
                timeSlider:
                    body.querySelector(
                        "[data-map-time-slider]"
                    ),
                timeLabel:
                    body.querySelector(
                        "[data-map-time-label]"
                    ),
                recordCount:
                    body.querySelector(
                        "[data-map-record-count]"
                    ),
                speciesSelect:
                    body.querySelector(
                        "[data-map-species-filter]"
                    ),
                providerSelect:
                    body.querySelector(
                        "[data-map-provider-filter]"
                    )
            };
        }

        createLegend() {
            const legend =
                document.createElement(
                    "aside"
                );

            legend.className =
                "terminal-map-legend";

            legend.dataset.mapLegend =
                "";

            const title =
                document.createElement(
                    "h4"
                );

            title.textContent =
                "Tactical Biodiversity Layers";

            const items = [
                [
                    "Observations",
                    "Point markers"
                ],
                [
                    "Ranges",
                    "Polygons"
                ],
                [
                    "Migration",
                    "Temporal tracks"
                ],
                [
                    "Season",
                    "Algorithmic filter"
                ]
            ];

            legend.appendChild(
                title
            );

            for (
                const [
                    label,
                    value
                ] of items
            ) {
                const row =
                    document.createElement(
                        "div"
                    );

                row.className =
                    "terminal-map-legend-item";

                const key =
                    document.createElement(
                        "span"
                    );

                key.textContent =
                    label;

                const description =
                    document.createElement(
                        "span"
                    );

                description.textContent =
                    value;

                row.append(
                    key,
                    description
                );

                legend.appendChild(
                    row
                );
            }

            const count =
                document.createElement(
                    "div"
                );

            count.className =
                "terminal-map-legend-item";

            const countLabel =
                document.createElement(
                    "span"
                );

            countLabel.textContent =
                "Visible";

            const countValue =
                document.createElement(
                    "span"
                );

            countValue.dataset.mapRecordCount =
                "";

            countValue.textContent =
                "0";

            count.append(
                countLabel,
                countValue
            );

            legend.appendChild(
                count
            );

            return legend;
        }

        createControls() {
            const controls =
                document.createElement(
                    "div"
                );

            controls.className =
                "terminal-map-controls";

            controls.dataset.mapControls =
                "";

            const rowOne =
                document.createElement(
                    "div"
                );

            rowOne.className =
                "terminal-map-control-row";

            const fit =
                this.makeButton(
                    "Fit",
                    () =>
                        this.fitToData()
                );

            const world =
                this.makeButton(
                    "World",
                    () =>
                        this.map?.setView(
                            [20, 0],
                            2
                        )
                );

            const play =
                this.makeButton(
                    "Play",
                    () =>
                        this.togglePlayback()
                );

            play.dataset.mapPlay =
                "";

            rowOne.append(
                fit,
                world,
                play
            );

            const rowTwo =
                document.createElement(
                    "div"
                );

            rowTwo.className =
                "terminal-map-control-row";

            const temporalMode =
                document.createElement(
                    "select"
                );

            temporalMode.setAttribute(
                "aria-label",
                "Temporal map mode"
            );

            for (
                const [
                    value,
                    label
                ] of [
                    [
                        "all",
                        "All time"
                    ],
                    [
                        "window",
                        "Time window"
                    ],
                    [
                        "season",
                        "Seasonal"
                    ],
                    [
                        "migration",
                        "Migration"
                    ]
                ]
            ) {
                const option =
                    document.createElement(
                        "option"
                    );

                option.value =
                    value;

                option.textContent =
                    label;

                temporalMode.appendChild(
                    option
                );
            }

            temporalMode.value =
                this.temporalMode;

            temporalMode.addEventListener(
                "change",
                () => {
                    this.temporalMode =
                        temporalMode.value;

                    this.renderTemporalState();
                }
            );

            rowTwo.appendChild(
                temporalMode
            );

            const speciesSelect =
                document.createElement(
                    "select"
                );

            speciesSelect.dataset.mapSpeciesFilter =
                "";

            speciesSelect.setAttribute(
                "aria-label",
                "Species filter"
            );

            speciesSelect.addEventListener(
                "change",
                () => {
                    this.speciesFilter =
                        speciesSelect.value ||
                        null;

                    this.renderTemporalState();
                }
            );

            const providerSelect =
                document.createElement(
                    "select"
                );

            providerSelect.dataset.mapProviderFilter =
                "";

            providerSelect.setAttribute(
                "aria-label",
                "Provider filter"
            );

            providerSelect.addEventListener(
                "change",
                () => {
                    this.providerFilter =
                        providerSelect.value ||
                        null;

                    this.renderTemporalState();
                }
            );

            controls.append(
                rowOne,
                rowTwo,
                speciesSelect,
                providerSelect
            );

            return controls;
        }

        createTimeline() {
            const timeline =
                document.createElement(
                    "div"
                );

            timeline.className =
                "terminal-map-timeline";

            timeline.dataset.mapTimeline =
                "";

            const header =
                document.createElement(
                    "div"
                );

            header.className =
                "terminal-map-timeline-header";

            const timeLabel =
                document.createElement(
                    "span"
                );

            timeLabel.dataset.mapTimeLabel =
                "";

            timeLabel.textContent =
                formatDate(
                    this.currentTime
                );

            const rangeLabel =
                document.createElement(
                    "span"
                );

            rangeLabel.textContent =
                this.temporal.start ===
                    null
                    ? "No dated observations"
                    : `${formatDate(this.temporal.start)} → ${formatDate(this.temporal.end)}`;

            header.append(
                timeLabel,
                rangeLabel
            );

            const slider =
                document.createElement(
                    "input"
                );

            slider.type =
                "range";

            slider.min =
                String(
                    this.temporal.start ??
                    this.currentTime
                );

            slider.max =
                String(
                    this.temporal.end ??
                    this.currentTime
                );

            slider.step =
                String(
                    60 *
                    60 *
                    1000
                );

            slider.value =
                String(
                    this.currentTime
                );

            slider.dataset.mapTimeSlider =
                "";

            slider.addEventListener(
                "input",
                () => {
                    this.setTime(
                        Number(
                            slider.value
                        )
                    );
                }
            );

            timeline.append(
                header,
                slider
            );

            return timeline;
        }

        makeButton(
            label,
            handler
        ) {
            const button =
                document.createElement(
                    "button"
                );

            button.type =
                "button";

            button.textContent =
                label;

            button.addEventListener(
                "click",
                handler
            );

            return button;
        }

        /*
        ======================================================================
        Initialization
        ======================================================================
        */

        async initialize() {
            this.L =
                await ensureLeaflet(
                    this.options
                );

            this.map =
                this.L.map(
                    this.elements.canvas,
                    {
                        center:
                            this.options.center,

                        zoom:
                            this.options.zoom,

                        minZoom:
                            this.options.minZoom,

                        maxZoom:
                            this.options.maxZoom,

                        worldCopyJump:
                            this.options.worldCopyJump,

                        preferCanvas:
                            this.options.preferCanvas,

                        zoomControl:
                            true,

                        attributionControl:
                            true
                    }
                );

            this.container.classList.toggle(
                "terminal-map-dark",
                this.options.dark
            );

            this.layers.tiles =
                this.L.tileLayer(
                    this.options.tileURL,
                    {
                        minZoom:
                            this.options.minZoom,

                        maxZoom:
                            this.options.maxZoom,

                        maxNativeZoom:
                            19,

                        attribution:
                            this.options.attribution,

                        crossOrigin:
                            true
                    }
                ).addTo(
                    this.map
                );

            this.layers.observations =
                this.L.layerGroup()
                    .addTo(
                        this.map
                    );

            this.layers.ranges =
                this.L.layerGroup()
                    .addTo(
                        this.map
                    );

            this.layers.paths =
                this.L.layerGroup()
                    .addTo(
                        this.map
                    );

            this.layers.migration =
                this.L.layerGroup()
                    .addTo(
                        this.map
                    );

            this.populateFilters();
            this.renderRanges();
            this.renderPaths();
            this.renderTemporalState();

            if (
                this.options.fitBounds
            ) {
                this.fitToData();
            }

            window.setTimeout(
                () =>
                    this.map.invalidateSize(),
                50
            );

            this.elements.status.textContent =
                `OpenStreetMap ready · ${this.observations.length} observations`;

            this.dispatchEvent(
                new CustomEvent(
                    "ready",
                    {
                        detail: {
                            controller:
                                this
                        }
                    }
                )
            );

            return this;
        }

        populateFilters() {
            const species =
                [
                    ...new Set(
                        this.observations.map(
                            observation =>
                                observation.species
                        )
                    )
                ].sort();

            const providers =
                [
                    ...new Set(
                        this.observations.map(
                            observation =>
                                observation.provider
                        )
                    )
                ].sort();

            this.fillSelect(
                this.elements.speciesSelect,
                "All species",
                species
            );

            this.fillSelect(
                this.elements.providerSelect,
                "All providers",
                providers
            );
        }

        fillSelect(
            select,
            label,
            values
        ) {
            if (!select) {
                return;
            }

            select.replaceChildren();

            const all =
                document.createElement(
                    "option"
                );

            all.value =
                "";

            all.textContent =
                label;

            select.appendChild(
                all
            );

            for (const value of values) {
                const option =
                    document.createElement(
                        "option"
                    );

                option.value =
                    value;

                option.textContent =
                    value;

                select.appendChild(
                    option
                );
            }
        }

        /*
        ======================================================================
        Rendering
        ======================================================================
        */

        filteredObservations() {
            let observations;

            if (
                this.temporalMode ===
                "all"
            ) {
                observations =
                    [
                        ...this.observations
                    ];
            } else if (
                this.temporalMode ===
                "season"
            ) {
                observations =
                    this.temporal.seasonal(
                        this.currentTime
                    );
            } else {
                observations =
                    this.temporal.at(
                        this.currentTime,
                        this.timeWindow
                    );
            }

            if (
                this.speciesFilter
            ) {
                observations =
                    observations.filter(
                        observation =>
                            observation.species ===
                            this.speciesFilter
                    );
            }

            if (
                this.providerFilter
            ) {
                observations =
                    observations.filter(
                        observation =>
                            observation.provider ===
                            this.providerFilter
                    );
            }

            return observations;
        }

        renderTemporalState() {
            if (!this.map) {
                return;
            }

            const visible =
                this.filteredObservations();

            this.layers.observations.clearLayers();
            this.layers.migration.clearLayers();
            this.markers.clear();
            this.migrationMarkers.clear();

            for (const observation of visible) {
                this.addObservationMarker(
                    observation
                );
            }

            if (
                this.temporalMode ===
                "migration"
            ) {
                this.renderMigrationPositions();
            }

            if (
                this.elements.recordCount
            ) {
                this.elements.recordCount.textContent =
                    String(
                        visible.length
                    );
            }

            if (
                this.elements.timeLabel
            ) {
                this.elements.timeLabel.textContent =
                    formatDate(
                        this.currentTime
                    );
            }

            if (
                this.elements.timeSlider
            ) {
                this.elements.timeSlider.value =
                    String(
                        this.currentTime
                    );
            }

            this.elements.status.textContent =
                `${visible.length} visible · ${this.temporalMode} mode · zoom ${this.map.getZoom()}`;

            this.dispatchEvent(
                new CustomEvent(
                    "time",
                    {
                        detail: {
                            timestamp:
                                this.currentTime,

                            mode:
                                this.temporalMode,

                            visible:
                                visible.length
                        }
                    }
                )
            );
        }

        addObservationMarker(
            observation
        ) {
            const marker =
                this.L.circleMarker(
                    [
                        observation.latitude,
                        observation.longitude
                    ],
                    {
                        radius:
                            this.options.pointRadius,

                        color:
                            this.options.primaryColor,

                        weight:
                            1.4,

                        opacity:
                            0.95,

                        fillColor:
                            this.options.primaryColor,

                        fillOpacity:
                            0.62,

                        className:
                            "terminal-map-marker-pulse"
                    }
                );

            marker.bindPopup(
                this.popupHTML(
                    observation
                ),
                {
                    className:
                        "terminal-map-popup"
                }
            );

            marker.addTo(
                this.layers.observations
            );

            this.markers.set(
                observation.id,
                marker
            );
        }

        popupHTML(
            observation
        ) {
            const escape =
                value =>
                    String(value ?? "")
                        .replace(/&/g, "&amp;")
                        .replace(/</g, "&lt;")
                        .replace(/>/g, "&gt;")
                        .replace(/"/g, "&quot;");

            return `
                <div class="terminal-map-popup">
                    <strong>${escape(observation.species)}</strong><br>
                    ${
                        observation.commonName
                            ? `${escape(observation.commonName)}<br>`
                            : ""
                    }
                    ID: ${escape(observation.id)}<br>
                    Provider: ${escape(observation.provider)}<br>
                    Time: ${escape(formatDate(observation.timestamp))}<br>
                    Coordinates:
                    ${observation.latitude.toFixed(5)},
                    ${observation.longitude.toFixed(5)}
                </div>
            `;
        }

        renderRanges() {
            this.layers.ranges.clearLayers();

            for (const record of this.records) {
                const geometry =
                    extractGeometry(
                        record
                    );

                if (!geometry) {
                    continue;
                }

                try {
                    const feature = {
                        type:
                            "Feature",
                        properties:
                            record,
                        geometry
                    };

                    this.L.geoJSON(
                        feature,
                        {
                            style:
                                () => ({
                                    color:
                                        this.options.primaryColor,

                                    weight:
                                        this.options.rangeWeight,

                                    opacity:
                                        0.9,

                                    fillColor:
                                        this.options.primaryColor,

                                    fillOpacity:
                                        this.options.rangeOpacity,

                                    dashArray:
                                        "5 4"
                                })
                        }
                    ).addTo(
                        this.layers.ranges
                    );
                } catch (error) {
                    console.warn(
                        "[SpeciedexTerminalMap] Unable to render range geometry:",
                        error
                    );
                }
            }
        }

        renderPaths() {
            this.layers.paths.clearLayers();

            for (const record of this.records) {
                const coordinates =
                    extractPath(
                        record
                    );

                if (
                    !Array.isArray(
                        coordinates
                    ) ||
                    coordinates.length <
                        2
                ) {
                    continue;
                }

                const latLngs =
                    toLeafletLatLngs(
                        coordinates
                    );

                if (
                    !latLngs.length
                ) {
                    continue;
                }

                this.L.polyline(
                    latLngs,
                    {
                        color:
                            this.options.primaryColor,

                        weight:
                            this.options.pathWeight,

                        opacity:
                            0.72,

                        dashArray:
                            "8 6"
                    }
                ).addTo(
                    this.layers.paths
                );
            }
        }

        renderMigrationPositions() {
            const bySpecies =
                new Map();

            for (const observation of this.observations) {
                if (
                    observation.timestamp ===
                    null
                ) {
                    continue;
                }

                if (
                    this.speciesFilter &&
                    observation.species !==
                    this.speciesFilter
                ) {
                    continue;
                }

                if (
                    this.providerFilter &&
                    observation.provider !==
                    this.providerFilter
                ) {
                    continue;
                }

                if (
                    !bySpecies.has(
                        observation.species
                    )
                ) {
                    bySpecies.set(
                        observation.species,
                        []
                    );
                }

                bySpecies.get(
                    observation.species
                ).push(
                    observation
                );
            }

            for (
                const [
                    species,
                    observations
                ] of bySpecies
            ) {
                const position =
                    this.temporal.interpolateTrack(
                        observations,
                        this.currentTime
                    );

                if (!position) {
                    continue;
                }

                const marker =
                    this.L.circleMarker(
                        [
                            position.latitude,
                            position.longitude
                        ],
                        {
                            radius:
                                this.options.pointRadius +
                                3,

                            color:
                                "#ffffff",

                            weight:
                                1.5,

                            fillColor:
                                this.options.primaryColor,

                            fillOpacity:
                                0.92
                        }
                    );

                marker.bindTooltip(
                    species,
                    {
                        permanent:
                            false,
                        direction:
                            "top"
                    }
                );

                marker.addTo(
                    this.layers.migration
                );

                this.migrationMarkers.set(
                    species,
                    marker
                );
            }
        }

        /*
        ======================================================================
        Time and Playback
        ======================================================================
        */

        setTime(
            timestamp
        ) {
            const parsed =
                parseDate(
                    timestamp
                );

            if (parsed === null) {
                throw new Error(
                    "Invalid map timestamp."
                );
            }

            this.currentTime =
                parsed;

            this.renderTemporalState();

            return this.currentTime;
        }

        setTimeWindow(
            milliseconds
        ) {
            const numeric =
                Number(
                    milliseconds
                );

            if (
                !Number.isFinite(
                    numeric
                ) ||
                numeric <=
                    0
            ) {
                throw new Error(
                    "Time window must be a positive number of milliseconds."
                );
            }

            this.timeWindow =
                numeric;

            this.renderTemporalState();

            return this.timeWindow;
        }

        play() {
            if (
                this.playing ||
                this.temporal.start ===
                    null ||
                this.temporal.end ===
                    null
            ) {
                return false;
            }

            this.playing =
                true;

            this.lastFrameTime =
                performance.now();

            const step =
                now => {
                    if (
                        !this.playing ||
                        this.destroyed
                    ) {
                        return;
                    }

                    const elapsed =
                        now -
                        this.lastFrameTime;

                    this.lastFrameTime =
                        now;

                    const duration =
                        this.temporal.end -
                        this.temporal.start;

                    const timelineRate =
                        duration /
                        120000;

                    this.currentTime +=
                        elapsed *
                        timelineRate *
                        this.options.animationSpeed;

                    if (
                        this.currentTime >
                        this.temporal.end
                    ) {
                        this.currentTime =
                            this.temporal.start;
                    }

                    this.renderTemporalState();

                    this.animationFrame =
                        window.requestAnimationFrame(
                            step
                        );
                };

            this.animationFrame =
                window.requestAnimationFrame(
                    step
                );

            const button =
                this.container.querySelector(
                    "[data-map-play]"
                );

            if (button) {
                button.textContent =
                    "Pause";
            }

            return true;
        }

        pause() {
            this.playing =
                false;

            if (
                this.animationFrame
            ) {
                window.cancelAnimationFrame(
                    this.animationFrame
                );

                this.animationFrame =
                    0;
            }

            const button =
                this.container.querySelector(
                    "[data-map-play]"
                );

            if (button) {
                button.textContent =
                    "Play";
            }

            return true;
        }

        togglePlayback() {
            return this.playing
                ? this.pause()
                : this.play();
        }

        /*
        ======================================================================
        Navigation
        ======================================================================
        */

        fitToData() {
            if (
                !this.map ||
                !this.observations.length
            ) {
                return false;
            }

            const bounds =
                this.L.latLngBounds(
                    this.observations.map(
                        observation => [
                            observation.latitude,
                            observation.longitude
                        ]
                    )
                );

            if (
                bounds.isValid()
            ) {
                this.map.fitBounds(
                    bounds,
                    {
                        padding:
                            [24, 24],

                        maxZoom:
                            12
                    }
                );

                return true;
            }

            return false;
        }

        focus(
            latitude,
            longitude,
            zoom = 10
        ) {
            const lat =
                parseNumber(
                    latitude
                );

            const lon =
                parseNumber(
                    longitude
                );

            if (
                lat === null ||
                lon === null
            ) {
                throw new Error(
                    "Map focus requires valid latitude and longitude."
                );
            }

            this.map.setView(
                [
                    lat,
                    lon
                ],
                clamp(
                    Number(zoom) ||
                    10,
                    this.options.minZoom,
                    this.options.maxZoom
                )
            );

            return {
                latitude:
                    lat,
                longitude:
                    lon,
                zoom:
                    this.map.getZoom()
            };
        }

        /*
        ======================================================================
        Data Updates
        ======================================================================
        */

        update(
            data,
            options = {}
        ) {
            this.pause();

            this.options = {
                ...this.options,
                ...options
            };

            this.records =
                flattenRecords(
                    data
                );

            this.observations =
                this.records
                    .map(
                        normalizeObservation
                    )
                    .filter(Boolean);

            this.temporal =
                new TemporalModel(
                    this.observations
                );

            this.currentTime =
                parseDate(
                    options.initialTime
                ) ??
                this.temporal.start ??
                Date.now();

            this.populateFilters();
            this.renderRanges();
            this.renderPaths();
            this.renderTemporalState();

            if (
                options.fitBounds !==
                false
            ) {
                this.fitToData();
            }

            return this;
        }

        /*
        ======================================================================
        Export and Diagnostics
        ======================================================================
        */

        toGeoJSON() {
            const features =
                [];

            for (const observation of this.observations) {
                features.push({
                    type:
                        "Feature",

                    geometry: {
                        type:
                            "Point",

                        coordinates: [
                            observation.longitude,
                            observation.latitude
                        ]
                    },

                    properties: {
                        id:
                            observation.id,

                        species:
                            observation.species,

                        common_name:
                            observation.commonName,

                        provider:
                            observation.provider,

                        timestamp:
                            observation.timestamp ===
                            null
                                ? null
                                : new Date(
                                    observation.timestamp
                                ).toISOString(),

                        ...observation.record
                    }
                });
            }

            for (const record of this.records) {
                const geometry =
                    extractGeometry(
                        record
                    );

                if (geometry) {
                    features.push({
                        type:
                            "Feature",

                        geometry,

                        properties:
                            record
                    });
                }
            }

            return {
                type:
                    "FeatureCollection",

                features
            };
        }

        status() {
            return {
                version:
                    VERSION,

                ready:
                    Boolean(
                        this.map
                    ),

                observations:
                    this.observations.length,

                records:
                    this.records.length,

                visible:
                    this.filteredObservations().length,

                temporalMode:
                    this.temporalMode,

                currentTime:
                    formatDate(
                        this.currentTime
                    ),

                start:
                    formatDate(
                        this.temporal.start
                    ),

                end:
                    formatDate(
                        this.temporal.end
                    ),

                speciesFilter:
                    this.speciesFilter,

                providerFilter:
                    this.providerFilter,

                playing:
                    this.playing,

                zoom:
                    this.map?.
                        getZoom?.() ??
                    null,

                center:
                    this.map
                        ? this.map.getCenter()
                        : null,

                tileURL:
                    this.options.tileURL,

                attribution:
                    "© OpenStreetMap contributors"
            };
        }

        destroy() {
            if (this.destroyed) {
                return;
            }

            this.pause();

            this.map?.
                remove?.();

            this.container.replaceChildren();

            this.destroyed =
                true;

            this.dispatchEvent(
                new CustomEvent(
                    "destroy"
                )
            );
        }
    }

    /*
    ==========================================================================
    Renderer
    ==========================================================================
    */

    async function mount(
        target,
        data = [],
        options = {}
    ) {
        const container =
            target instanceof
            Element
                ? target
                : document.createElement(
                    "section"
                );

        const controller =
            new TacticalMapController(
                container,
                data,
                options
            );

        await controller.initialize();

        container.controller =
            controller;

        container.update =
            (
                nextData,
                nextOptions
            ) =>
                controller.update(
                    nextData,
                    nextOptions
                );

        container.destroy =
            () =>
                controller.destroy();

        return controller;
    }

    function render(
        data,
        options = {}
    ) {
        const container =
            document.createElement(
                "section"
            );

        container.className =
            "terminal-renderer terminal-renderer-map";

        container.dataset.renderer =
            "map";

        const controller =
            new TacticalMapController(
                container,
                data,
                options
            );

        container.controller =
            controller;

        container.ready =
            controller.initialize();

        container.update =
            (
                nextData,
                nextOptions
            ) =>
                controller.update(
                    nextData,
                    nextOptions
                );

        container.destroy =
            () =>
                controller.destroy();

        return container;
    }

    /*
    ==========================================================================
    Initialization
    ==========================================================================
    */

    function initialize(
        context
    ) {
        if (
            context.mapRenderer?.
                Controller ===
            TacticalMapController
        ) {
            return context.mapRenderer;
        }

        const renderer = {
            render,
            mount,
            Controller:
                TacticalMapController,
            TemporalModel,
            ensureLeaflet,
            normalizeObservation,
            extractGeometry,
            extractPath
        };

        context.registerRenderer?.(
            "map",
            renderer
        );

        context.mapRenderer =
            renderer;

        context.maps =
            context.maps ||
            new Set();

        return renderer;
    }

    /*
    ==========================================================================
    Commands
    ==========================================================================
    */

    function activeMap(
        context
    ) {
        return (
            context.root?.
                querySelector?.(
                    ".terminal-renderer-map"
                )?.
                controller ||
            null
        );
    }

    const commands =
        [
            {
                name:
                    "map",

                category:
                    "visualization",

                description:
                    "Render a tactical OpenStreetMap species distribution map.",

                usage:
                    "map [collection] [--species NAME] [--provider NAME] [--mode all|window|season|migration]",

                handler: ({
                    args,
                    parsed,
                    context
                }) => {
                    const collection =
                        args[0] ||
                        "records";

                    const records =
                        context.library?.get?.(
                            collection
                        ) ||
                        [];

                    const element =
                        render(
                            records,
                            {
                                title:
                                    `Speciedex Tactical Map: ${collection}`,

                                initialTime:
                                    parsed.options.time ||
                                    null,

                                zoom:
                                    parseNumber(
                                        parsed.options.zoom,
                                        DEFAULT_OPTIONS.zoom
                                    ),

                                showGrid:
                                    !parsed.flags["no-grid"],

                                fitBounds:
                                    !parsed.flags["no-fit"]
                            }
                        );

                    element.ready.then(
                        () => {
                            const controller =
                                element.controller;

                            if (
                                parsed.options.species
                            ) {
                                controller.speciesFilter =
                                    parsed.options.species;
                            }

                            if (
                                parsed.options.provider
                            ) {
                                controller.providerFilter =
                                    parsed.options.provider;
                            }

                            if (
                                parsed.options.mode
                            ) {
                                controller.temporalMode =
                                    parsed.options.mode;
                            }

                            controller.renderTemporalState();
                        }
                    );

                    return element;
                }
            },

            {
                name:
                    "map-status",

                category:
                    "visualization",

                description:
                    "Display active tactical map status.",

                usage:
                    "map-status",

                handler: ({
                    context,
                    writeJSON
                }) => {
                    const controller =
                        activeMap(
                            context
                        );

                    if (!controller) {
                        throw new Error(
                            "No active map renderer is available."
                        );
                    }

                    return writeJSON(
                        controller.status()
                    );
                }
            },

            {
                name:
                    "map-focus",

                category:
                    "visualization",

                description:
                    "Focus the active map on latitude, longitude, and zoom.",

                usage:
                    "map-focus <latitude> <longitude> [zoom]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    const controller =
                        activeMap(
                            context
                        );

                    if (!controller) {
                        throw new Error(
                            "No active map renderer is available."
                        );
                    }

                    if (
                        args.length <
                        2
                    ) {
                        throw new Error(
                            "Usage: map-focus <latitude> <longitude> [zoom]"
                        );
                    }

                    return writeJSON(
                        controller.focus(
                            args[0],
                            args[1],
                            args[2] ||
                            10
                        )
                    );
                }
            },

            {
                name:
                    "map-time",

                category:
                    "visualization",

                description:
                    "Set the active map time.",

                usage:
                    "map-time <ISO-8601 timestamp>",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const controller =
                        activeMap(
                            context
                        );

                    if (!controller) {
                        throw new Error(
                            "No active map renderer is available."
                        );
                    }

                    const value =
                        args.join(
                            " "
                        );

                    controller.setTime(
                        value
                    );

                    return write(
                        `Map time: ${formatDate(controller.currentTime)}`,
                        "success"
                    );
                }
            },

            {
                name:
                    "map-mode",

                category:
                    "visualization",

                description:
                    "Set temporal rendering mode.",

                usage:
                    "map-mode <all|window|season|migration>",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const controller =
                        activeMap(
                            context
                        );

                    if (!controller) {
                        throw new Error(
                            "No active map renderer is available."
                        );
                    }

                    const mode =
                        String(
                            args[0] ||
                            ""
                        ).toLowerCase();

                    if (
                        ![
                            "all",
                            "window",
                            "season",
                            "migration"
                        ].includes(
                            mode
                        )
                    ) {
                        throw new Error(
                            "Use: map-mode all|window|season|migration"
                        );
                    }

                    controller.temporalMode =
                        mode;

                    controller.renderTemporalState();

                    return write(
                        `Map temporal mode: ${mode}`,
                        "success"
                    );
                }
            },

            {
                name:
                    "map-play",

                category:
                    "visualization",

                description:
                    "Start temporal map playback.",

                usage:
                    "map-play",

                handler: ({
                    context,
                    write
                }) => {
                    const controller =
                        activeMap(
                            context
                        );

                    if (!controller) {
                        throw new Error(
                            "No active map renderer is available."
                        );
                    }

                    controller.play();

                    return write(
                        "Map playback started.",
                        "success"
                    );
                }
            },

            {
                name:
                    "map-pause",

                category:
                    "visualization",

                description:
                    "Pause temporal map playback.",

                usage:
                    "map-pause",

                handler: ({
                    context,
                    write
                }) => {
                    const controller =
                        activeMap(
                            context
                        );

                    if (!controller) {
                        throw new Error(
                            "No active map renderer is available."
                        );
                    }

                    controller.pause();

                    return write(
                        "Map playback paused.",
                        "success"
                    );
                }
            },

            {
                name:
                    "map-fit",

                category:
                    "visualization",

                description:
                    "Fit the active map to all species observations.",

                usage:
                    "map-fit",

                handler: ({
                    context,
                    write
                }) => {
                    const controller =
                        activeMap(
                            context
                        );

                    if (!controller) {
                        throw new Error(
                            "No active map renderer is available."
                        );
                    }

                    controller.fitToData();

                    return write(
                        "Map fitted to data.",
                        "success"
                    );
                }
            },

            {
                name:
                    "map-export",

                category:
                    "visualization",

                description:
                    "Export the active map data as GeoJSON.",

                usage:
                    "map-export [filename]",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const controller =
                        activeMap(
                            context
                        );

                    if (!controller) {
                        throw new Error(
                            "No active map renderer is available."
                        );
                    }

                    const filename =
                        args[0] ||
                        "speciedex-map.geojson";

                    const payload =
                        JSON.stringify(
                            controller.toGeoJSON(),
                            null,
                            2
                        );

                    const blob =
                        new Blob(
                            [
                                payload
                            ],
                            {
                                type:
                                    "application/geo+json"
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

                    anchor.href =
                        url;

                    anchor.download =
                        filename;

                    anchor.click();

                    window.setTimeout(
                        () =>
                            URL.revokeObjectURL(
                                url
                            ),
                        1000
                    );

                    return write(
                        `Map exported to ${filename}.`,
                        "success"
                    );
                }
            }
        ];

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

            PRIMARY_COLOR,
            OSM_TILE_URL,
            OSM_ATTRIBUTION,
            DEFAULT_OPTIONS,
            TacticalMapController,
            TemporalModel,

            resolveCoordinates,
            resolveTimestamp,
            resolveSpecies,
            resolveCommonName,
            resolveID,
            resolveProvider,
            normalizeObservation,
            extractGeometry,
            extractPath,
            seasonForTimestamp,
            ensureLeaflet,
            injectMapStyles,

            render,
            mount,

            initialize,
            init:
                initialize,
            setup:
                initialize,

            commands
        });

    window.SpeciedexTerminalMap =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules ||
        {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    document.dispatchEvent(
        new CustomEvent(
            "speciedex:terminal-module-available",
            {
                detail: {
                    name:
                        MODULE_NAME,

                    module:
                        api
                }
            }
        )
    );
})(window, document);
