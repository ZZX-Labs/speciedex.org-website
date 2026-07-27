/*
========================================================================
Speciedex.org
Map Worker
========================================================================

High-performance worker-side geospatial analysis for SpeciedexTerminal.

Designed for browser integration through:

    _partials/splash.html
        -> _partials/terminal.html
        -> terminal WorkerPool
        -> static/js/terminal/workers/map-worker.js

The worker accepts JSON-compatible records emitted by the static site,
terminal JavaScript modules, Python workflow products, and archive exports.

Features:

    • Coordinate normalization from common field names and nested records
    • Antimeridian-aware bounds and longitude spans
    • Spherical centroids and weighted centroids
    • Haversine distance, bearings, and destination points
    • Radius filtering and nearest-neighbor lookup
    • Grid clustering and distance-based clustering
    • Bounding-box filtering
    • GeoJSON conversion
    • Request cancellation, progress events, and structured responses

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

"use strict";

const WORKER_NAME = "map";
const WORKER_VERSION = "3.0.0";

const EARTH_RADIUS_METERS = 6371008.8;
const MAX_POINTS = 1000000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 10000;
const DEFAULT_PROGRESS_INTERVAL = 5000;
const MIN_PROGRESS_INTERVAL = 100;
const MAX_PROGRESS_INTERVAL = 100000;
const YIELD_INTERVAL = 2048;

const activeRequests = new Map();
const cancelledRequests = new Set();

function now() {
    return (
        typeof performance !== "undefined" &&
        typeof performance.now === "function"
    )
        ? performance.now()
        : Date.now();
}

function text(value) {
    return String(value ?? "").trim();
}

function key(value) {
    return text(value).toLowerCase();
}

function number(value, fallback = null) {
    const result = Number(value);
    return Number.isFinite(result)
        ? result
        : fallback;
}

function integer(value, fallback, minimum, maximum) {
    const result = Number.parseInt(value, 10);

    return Number.isFinite(result)
        ? Math.min(maximum, Math.max(minimum, result))
        : fallback;
}

function boolean(value, fallback = false) {
    if (typeof value === "boolean") {
        return value;
    }

    if (typeof value === "number") {
        return value !== 0;
    }

    const normalized = key(value);

    if (["true", "1", "yes", "on"].includes(normalized)) {
        return true;
    }

    if (["false", "0", "no", "off", ""].includes(normalized)) {
        return false;
    }

    return fallback;
}

function asArray(value) {
    if (value === undefined || value === null) {
        return [];
    }

    return Array.isArray(value)
        ? value
        : [value];
}

function createError(message, code, name = "Error") {
    const error = new Error(message);
    error.name = name;
    error.code = code;
    return error;
}

function serializeError(error) {
    return {
        name: error?.name || "Error",
        message: error?.message || String(error),
        stack: error?.stack || null,
        code: error?.code || null
    };
}

function send(type, id, payload = {}) {
    self.postMessage({
        type,
        id,
        worker: WORKER_NAME,
        workerVersion: WORKER_VERSION,
        ...payload
    });
}

function respond(id, result, error = null) {
    send(
        "response",
        id,
        error
            ? { error: serializeError(error) }
            : { result }
    );
}

function progress(id, phase, completed, total, extra = {}) {
    const percent = total > 0
        ? Math.min(100, (completed / total) * 100)
        : 100;

    send("progress", id, {
        phase,
        completed,
        total,
        percent,
        ...extra
    });
}

function yieldToWorker() {
    return new Promise(resolve => {
        setTimeout(resolve, 0);
    });
}

function assertActive(id) {
    if (id === null || id === undefined) {
        return;
    }

    if (
        cancelledRequests.has(id) ||
        activeRequests.get(id)?.cancelled === true
    ) {
        throw createError(
            "Map worker request cancelled.",
            "MAP_WORKER_CANCELLED",
            "AbortError"
        );
    }
}

function markCancelled(targetId) {
    if (targetId === null || targetId === undefined) {
        return false;
    }

    cancelledRequests.add(targetId);

    const request = activeRequests.get(targetId);

    if (request) {
        request.cancelled = true;
        return true;
    }

    return false;
}

function normalizeMessage(raw) {
    const message =
        raw && typeof raw === "object"
            ? raw
            : {};

    const payload =
        message.payload ??
        message.data ??
        message.options ??
        {};

    return {
        id:
            message.id ??
            message.requestId ??
            message.request_id ??
            null,

        type:
            key(
                message.type ??
                message.operation ??
                message.action ??
                message.command
            ),

        payload:
            payload &&
            typeof payload === "object"
                ? payload
                : {},

        targetId:
            message.targetId ??
            message.target_id ??
            payload?.targetId ??
            payload?.target_id ??
            payload?.id ??
            null
    };
}

self.addEventListener("message", async event => {
    const message = normalizeMessage(event.data);

    if (message.type === "cancel" || message.type === "abort") {
        const found = markCancelled(message.targetId);

        if (
            message.id !== null &&
            message.id !== message.targetId
        ) {
            respond(message.id, {
                cancelled: true,
                found,
                targetId: message.targetId
            });
        }

        return;
    }

    const id =
        message.id ??
        `${WORKER_NAME}:${Date.now()}:${Math.random()
            .toString(36)
            .slice(2)}`;

    activeRequests.set(id, {
        cancelled: false,
        startedAt: now(),
        type: message.type
    });

    cancelledRequests.delete(id);

    try {
        const result = await handle(
            message.type,
            message.payload,
            id
        );

        assertActive(id);
        respond(id, result);
    } catch (error) {
        respond(id, null, error);
    } finally {
        activeRequests.delete(id);
        cancelledRequests.delete(id);
    }
});

async function handle(type, payload, id) {
    switch (type) {
        case "normalize":
        case "normalize-points":
            return normalizePoints(
                extractPoints(payload),
                payload,
                id
            );

        case "bounds":
        case "bbox":
            return bounds(payload, id);

        case "cluster":
        case "grid-cluster":
            return gridCluster(payload, id);

        case "radius-cluster":
        case "distance-cluster":
            return radiusCluster(payload, id);

        case "centroid":
            return centroid(payload, id);

        case "distance":
            return distance(payload);

        case "bearing":
            return bearing(payload);

        case "destination":
            return destination(payload);

        case "within":
        case "radius":
            return within(payload, id);

        case "nearest":
        case "nearest-neighbor":
            return nearest(payload, id);

        case "box":
        case "within-bounds":
            return withinBounds(payload, id);

        case "geojson":
        case "to-geojson":
            return toGeoJSON(payload, id);

        case "status":
            return status();

        case "ping":
            return {
                pong: true,
                worker: WORKER_NAME,
                version: WORKER_VERSION,
                timestamp: new Date().toISOString()
            };

        default:
            throw createError(
                `Unsupported map operation: ${type || "(empty)"}`,
                "MAP_WORKER_UNSUPPORTED_OPERATION"
            );
    }
}

function status() {
    return {
        ready: true,
        worker: WORKER_NAME,
        workerVersion: WORKER_VERSION,
        activeRequests: activeRequests.size,
        earthRadiusMeters: EARTH_RADIUS_METERS,
        limits: {
            maxPoints: MAX_POINTS,
            defaultLimit: DEFAULT_LIMIT,
            maxLimit: MAX_LIMIT
        }
    };
}

function extractPoints(payload = {}) {
    const candidate =
        payload.points ??
        payload.records ??
        payload.items ??
        payload.results ??
        payload.rows ??
        payload.data ??
        [];

    if (Array.isArray(candidate)) {
        return candidate;
    }

    if (
        candidate &&
        typeof candidate === "object"
    ) {
        for (const name of [
            "points",
            "records",
            "items",
            "results",
            "rows",
            "data"
        ]) {
            if (Array.isArray(candidate[name])) {
                return candidate[name];
            }
        }
    }

    return [];
}

function tokenizePath(path) {
    return text(path)
        .replace(/\[["']?([^"'[\]]+)["']?\]/g, ".$1")
        .split(".")
        .map(text)
        .filter(Boolean);
}

function pathValue(record, path) {
    const parts = tokenizePath(path);

    if (!parts.length) {
        return undefined;
    }

    let value = record;

    for (const part of parts) {
        if (value === null || value === undefined) {
            return undefined;
        }

        if (Array.isArray(value) && /^\d+$/.test(part)) {
            value = value[Number(part)];
            continue;
        }

        value = value[part];
    }

    return value;
}

function latitude(point, options = {}) {
    if (!point || typeof point !== "object") {
        return null;
    }

    const path =
        options.latitudeField ??
        options.latitude_field ??
        options.latField ??
        options.lat_field;

    if (path) {
        return number(pathValue(point, path));
    }

    return number(
        point.lat ??
        point.latitude ??
        point.y ??
        point.location?.lat ??
        point.location?.latitude ??
        point.coordinates?.lat ??
        (
            Array.isArray(point.coordinates)
                ? point.coordinates[1]
                : undefined
        )
    );
}

function longitude(point, options = {}) {
    if (!point || typeof point !== "object") {
        return null;
    }

    const path =
        options.longitudeField ??
        options.longitude_field ??
        options.lngField ??
        options.lng_field ??
        options.lonField ??
        options.lon_field;

    if (path) {
        return number(pathValue(point, path));
    }

    return number(
        point.lng ??
        point.lon ??
        point.long ??
        point.longitude ??
        point.x ??
        point.location?.lng ??
        point.location?.lon ??
        point.location?.longitude ??
        point.coordinates?.lng ??
        point.coordinates?.lon ??
        point.coordinates?.longitude ??
        (
            Array.isArray(point.coordinates)
                ? point.coordinates[0]
                : undefined
        )
    );
}

function normalizeLongitude(value) {
    const lng = number(value);

    return lng === null
        ? null
        : (((lng + 180) % 360 + 360) % 360) - 180;
}

function normalizeLatitude(value, clamp = false) {
    const lat = number(value);

    if (lat === null) {
        return null;
    }

    if (clamp) {
        return Math.min(90, Math.max(-90, lat));
    }

    return lat >= -90 && lat <= 90
        ? lat
        : null;
}

function normalizePoint(point, index = 0, options = {}) {
    const lat = normalizeLatitude(
        latitude(point, options),
        boolean(
            options.clampLatitude ??
            options.clamp_latitude,
            false
        )
    );

    const lng = normalizeLongitude(
        longitude(point, options)
    );

    if (lat === null || lng === null) {
        return null;
    }

    const output = {
        ...(
            point &&
            typeof point === "object" &&
            !Array.isArray(point)
                ? point
                : {}
        ),
        lat,
        lng,
        index:
            point?.index ??
            point?.sourceIndex ??
            point?.source_index ??
            index
    };

    if (
        boolean(
            options.includeSource ??
            options.include_source,
            false
        )
    ) {
        output.source = point;
    }

    return output;
}

async function normalizePoints(points, options = {}, id = null) {
    const startedAt = now();
    const input = Array.isArray(points)
        ? points
        : [];

    if (input.length > MAX_POINTS) {
        throw createError(
            `Map point limit exceeded: ${input.length} > ${MAX_POINTS}.`,
            "MAP_WORKER_POINT_LIMIT",
            "RangeError"
        );
    }

    const valid = [];
    const invalid = [];
    const progressEnabled = boolean(
        options.progress,
        false
    );

    const progressInterval = integer(
        options.progressInterval ??
        options.progress_interval,
        DEFAULT_PROGRESS_INTERVAL,
        MIN_PROGRESS_INTERVAL,
        MAX_PROGRESS_INTERVAL
    );

    for (let index = 0; index < input.length; index += 1) {
        assertActive(id);

        const point = normalizePoint(
            input[index],
            index,
            options
        );

        if (point) {
            valid.push(point);
        } else {
            invalid.push({
                index,
                point: input[index]
            });
        }

        if (
            progressEnabled &&
            index > 0 &&
            index % progressInterval === 0
        ) {
            progress(
                id,
                "normalize",
                index,
                input.length,
                {
                    valid: valid.length,
                    invalid: invalid.length
                }
            );
        }

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    return {
        points: valid,
        valid: valid.length,
        invalid: invalid.length,
        rejected:
            boolean(
                options.includeRejected ??
                options.include_rejected,
                false
            )
                ? invalid
                : undefined,
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
    };
}

async function bounds(payload = {}, id = null) {
    const normalized = await normalizePoints(
        extractPoints(payload),
        payload,
        id
    );

    const points = normalized.points;

    if (!points.length) {
        return null;
    }

    let north = -90;
    let south = 90;

    for (const point of points) {
        north = Math.max(north, point.lat);
        south = Math.min(south, point.lat);
    }

    const longitudes = points
        .map(point => normalizeLongitude(point.lng))
        .sort((left, right) => left - right);

    const normalWest = longitudes[0];
    const normalEast = longitudes.at(-1);
    const normalSpan = normalEast - normalWest;

    let largestGap = -1;
    let largestGapIndex = -1;

    for (let index = 0; index < longitudes.length; index += 1) {
        const current = longitudes[index];
        const next =
            index === longitudes.length - 1
                ? longitudes[0] + 360
                : longitudes[index + 1];

        const gap = next - current;

        if (gap > largestGap) {
            largestGap = gap;
            largestGapIndex = index;
        }
    }

    const wrappedWest = normalizeLongitude(
        longitudes[
            (largestGapIndex + 1) % longitudes.length
        ]
    );

    const wrappedEast = normalizeLongitude(
        longitudes[largestGapIndex]
    );

    const wrappedSpan = 360 - largestGap;
    const crossesAntimeridian = wrappedSpan < normalSpan;

    const result = {
        north,
        south,
        east:
            crossesAntimeridian
                ? wrappedEast
                : normalEast,
        west:
            crossesAntimeridian
                ? wrappedWest
                : normalWest,
        crossesAntimeridian,
        longitudeSpan:
            crossesAntimeridian
                ? wrappedSpan
                : normalSpan,
        latitudeSpan: north - south,
        center: sphericalCentroid(points),
        count: points.length,
        invalid: normalized.invalid
    };

    result.geojson = {
        type: "Polygon",
        coordinates: [
            boundsPolygonCoordinates(result)
        ]
    };

    return result;
}

function boundsPolygonCoordinates(value) {
    if (!value.crossesAntimeridian) {
        return [
            [value.west, value.south],
            [value.east, value.south],
            [value.east, value.north],
            [value.west, value.north],
            [value.west, value.south]
        ];
    }

    /*
    GeoJSON polygons do not natively represent a wrapped interval. The worker
    returns a ring using the equivalent unwrapped eastern longitude.
    */
    const east = value.east < value.west
        ? value.east + 360
        : value.east;

    return [
        [value.west, value.south],
        [east, value.south],
        [east, value.north],
        [value.west, value.north],
        [value.west, value.south]
    ];
}

function round(value, precision) {
    const factor = 10 ** precision;
    return Math.round(value * factor) / factor;
}

async function gridCluster(payload = {}, id = null) {
    const startedAt = now();
    const normalized = await normalizePoints(
        extractPoints(payload),
        payload,
        id
    );

    const precision = integer(
        payload.precision,
        1,
        0,
        8
    );

    const includePoints = boolean(
        payload.includePoints ??
        payload.include_points,
        true
    );

    const clusters = new Map();

    for (
        let index = 0;
        index < normalized.points.length;
        index += 1
    ) {
        assertActive(id);

        const point = normalized.points[index];
        const latCell = round(point.lat, precision);
        const lngCell = round(point.lng, precision);
        const clusterKey =
            `${latCell.toFixed(precision)},` +
            `${lngCell.toFixed(precision)}`;

        let value = clusters.get(clusterKey);

        if (!value) {
            value = {
                key: clusterKey,
                count: 0,
                points: [],
                latitudeTotal: 0,
                longitudeX: 0,
                longitudeY: 0,
                north: -90,
                south: 90,
                longitudes: []
            };

            clusters.set(clusterKey, value);
        }

        value.count += 1;
        value.latitudeTotal += point.lat;

        const radians = toRadians(point.lng);
        value.longitudeX += Math.cos(radians);
        value.longitudeY += Math.sin(radians);
        value.north = Math.max(value.north, point.lat);
        value.south = Math.min(value.south, point.lat);
        value.longitudes.push(point.lng);

        if (includePoints) {
            value.points.push(point);
        }

        if (
            boolean(payload.progress, false) &&
            index > 0 &&
            index % DEFAULT_PROGRESS_INTERVAL === 0
        ) {
            progress(
                id,
                "cluster",
                index,
                normalized.points.length,
                {
                    clusters: clusters.size
                }
            );
        }

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    const results = [...clusters.values()]
        .map(value => {
            const longitudeBounds =
                antimeridianLongitudeBounds(value.longitudes);

            return {
                key: value.key,
                count: value.count,
                centroid: {
                    lat: value.latitudeTotal / value.count,
                    lng: normalizeLongitude(
                        toDegrees(
                            Math.atan2(
                                value.longitudeY,
                                value.longitudeX
                            )
                        )
                    )
                },
                bounds: {
                    north: value.north,
                    south: value.south,
                    ...longitudeBounds
                },
                points:
                    includePoints
                        ? value.points
                        : undefined
            };
        })
        .sort((left, right) =>
            right.count - left.count ||
            left.key.localeCompare(right.key)
        );

    return {
        precision,
        points: normalized.points.length,
        invalid: normalized.invalid,
        clusters: results.length,
        results,
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
    };
}

function antimeridianLongitudeBounds(longitudes) {
    if (!longitudes.length) {
        return {
            east: null,
            west: null,
            crossesAntimeridian: false,
            longitudeSpan: 0
        };
    }

    const values = longitudes
        .map(normalizeLongitude)
        .sort((left, right) => left - right);

    if (values.length === 1) {
        return {
            east: values[0],
            west: values[0],
            crossesAntimeridian: false,
            longitudeSpan: 0
        };
    }

    const normalWest = values[0];
    const normalEast = values.at(-1);
    const normalSpan = normalEast - normalWest;

    let largestGap = -1;
    let largestGapIndex = -1;

    for (let index = 0; index < values.length; index += 1) {
        const current = values[index];
        const next =
            index === values.length - 1
                ? values[0] + 360
                : values[index + 1];

        const gap = next - current;

        if (gap > largestGap) {
            largestGap = gap;
            largestGapIndex = index;
        }
    }

    const wrappedSpan = 360 - largestGap;

    if (wrappedSpan < normalSpan) {
        return {
            west: normalizeLongitude(
                values[
                    (largestGapIndex + 1) % values.length
                ]
            ),
            east: normalizeLongitude(
                values[largestGapIndex]
            ),
            crossesAntimeridian: true,
            longitudeSpan: wrappedSpan
        };
    }

    return {
        west: normalWest,
        east: normalEast,
        crossesAntimeridian: false,
        longitudeSpan: normalSpan
    };
}

async function radiusCluster(payload = {}, id = null) {
    const startedAt = now();
    const normalized = await normalizePoints(
        extractPoints(payload),
        payload,
        id
    );

    const radiusMeters = distanceToMeters(
        payload.radiusMeters ??
        payload.radius_meters ??
        payload.radius ??
        1000,
        payload.unit ??
        payload.units ??
        "meters"
    );

    if (radiusMeters < 0) {
        throw createError(
            "Cluster radius must be non-negative.",
            "MAP_WORKER_INVALID_RADIUS",
            "RangeError"
        );
    }

    const minimumPoints = integer(
        payload.minimumPoints ??
        payload.minimum_points ??
        payload.minPoints ??
        payload.min_points,
        1,
        1,
        MAX_POINTS
    );

    const points = normalized.points;
    const visited = new Uint8Array(points.length);
    const assigned = new Int32Array(points.length);
    assigned.fill(-1);

    const clusters = [];
    const noise = [];

    for (let index = 0; index < points.length; index += 1) {
        assertActive(id);

        if (visited[index]) {
            continue;
        }

        visited[index] = 1;

        const neighbors = neighborhood(
            points,
            index,
            radiusMeters
        );

        if (neighbors.length < minimumPoints) {
            noise.push(points[index]);
            continue;
        }

        const clusterIndex = clusters.length;
        const members = [];
        const queue = [...neighbors];
        const queued = new Set(queue);

        while (queue.length) {
            assertActive(id);

            const memberIndex = queue.shift();

            if (!visited[memberIndex]) {
                visited[memberIndex] = 1;

                const additional = neighborhood(
                    points,
                    memberIndex,
                    radiusMeters
                );

                if (additional.length >= minimumPoints) {
                    for (const candidate of additional) {
                        if (!queued.has(candidate)) {
                            queue.push(candidate);
                            queued.add(candidate);
                        }
                    }
                }
            }

            if (assigned[memberIndex] === -1) {
                assigned[memberIndex] = clusterIndex;
                members.push(points[memberIndex]);
            }
        }

        clusters.push({
            id: clusterIndex,
            count: members.length,
            centroid: sphericalCentroid(members),
            points:
                boolean(
                    payload.includePoints ??
                    payload.include_points,
                    true
                )
                    ? members
                    : undefined
        });

        if (
            index > 0 &&
            index % 100 === 0
        ) {
            progress(
                id,
                "radius-cluster",
                index,
                points.length,
                {
                    clusters: clusters.length,
                    noise: noise.length
                }
            );

            await yieldToWorker();
        }
    }

    return {
        radiusMeters,
        minimumPoints,
        points: points.length,
        invalid: normalized.invalid,
        clusters: clusters.length,
        noise:
            boolean(
                payload.includeNoise ??
                payload.include_noise,
                false
            )
                ? noise
                : noise.length,
        results: clusters,
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
    };
}

function neighborhood(points, originIndex, radiusMeters) {
    const neighbors = [];
    const origin = points[originIndex];

    for (let index = 0; index < points.length; index += 1) {
        if (haversine(origin, points[index]) <= radiusMeters) {
            neighbors.push(index);
        }
    }

    return neighbors;
}

async function centroid(payload = {}, id = null) {
    const normalized = await normalizePoints(
        extractPoints(payload),
        payload,
        id
    );

    if (!normalized.points.length) {
        return null;
    }

    const weightField =
        payload.weightField ??
        payload.weight_field ??
        null;

    const result = weightField
        ? weightedSphericalCentroid(
            normalized.points,
            weightField
        )
        : sphericalCentroid(normalized.points);

    return {
        ...result,
        count: normalized.points.length,
        invalid: normalized.invalid,
        weighted: Boolean(weightField),
        weightField
    };
}

function sphericalCentroid(points) {
    let x = 0;
    let y = 0;
    let z = 0;

    for (const point of points) {
        const lat = toRadians(point.lat);
        const lng = toRadians(point.lng);
        const cosLat = Math.cos(lat);

        x += cosLat * Math.cos(lng);
        y += cosLat * Math.sin(lng);
        z += Math.sin(lat);
    }

    x /= points.length;
    y /= points.length;
    z /= points.length;

    return {
        lat: toDegrees(
            Math.atan2(
                z,
                Math.sqrt(x * x + y * y)
            )
        ),
        lng: normalizeLongitude(
            toDegrees(Math.atan2(y, x))
        )
    };
}

function weightedSphericalCentroid(points, weightField) {
    let x = 0;
    let y = 0;
    let z = 0;
    let totalWeight = 0;

    for (const point of points) {
        const weight = number(
            pathValue(point, weightField),
            0
        );

        if (weight <= 0) {
            continue;
        }

        const lat = toRadians(point.lat);
        const lng = toRadians(point.lng);
        const cosLat = Math.cos(lat);

        x += cosLat * Math.cos(lng) * weight;
        y += cosLat * Math.sin(lng) * weight;
        z += Math.sin(lat) * weight;
        totalWeight += weight;
    }

    if (totalWeight <= 0) {
        return sphericalCentroid(points);
    }

    x /= totalWeight;
    y /= totalWeight;
    z /= totalWeight;

    return {
        lat: toDegrees(
            Math.atan2(
                z,
                Math.sqrt(x * x + y * y)
            )
        ),
        lng: normalizeLongitude(
            toDegrees(Math.atan2(y, x))
        ),
        totalWeight
    };
}

function distance(payload = {}) {
    const from = normalizePoint(
        payload.from ??
        payload.origin ??
        payload.a,
        0,
        payload
    );

    const to = normalizePoint(
        payload.to ??
        payload.destination ??
        payload.b,
        1,
        payload
    );

    if (!from || !to) {
        throw createError(
            "Two valid map points are required.",
            "MAP_WORKER_POINTS_REQUIRED",
            "TypeError"
        );
    }

    const meters = haversine(from, to);

    return {
        from,
        to,
        meters,
        kilometers: meters / 1000,
        miles: meters / 1609.344,
        nauticalMiles: meters / 1852,
        bearing: initialBearing(from, to)
    };
}

function bearing(payload = {}) {
    const from = normalizePoint(
        payload.from ??
        payload.origin ??
        payload.a,
        0,
        payload
    );

    const to = normalizePoint(
        payload.to ??
        payload.destination ??
        payload.b,
        1,
        payload
    );

    if (!from || !to) {
        throw createError(
            "Two valid map points are required.",
            "MAP_WORKER_POINTS_REQUIRED",
            "TypeError"
        );
    }

    return {
        from,
        to,
        initialBearing: initialBearing(from, to),
        finalBearing: finalBearing(from, to)
    };
}

function destination(payload = {}) {
    const origin = normalizePoint(
        payload.origin ??
        payload.from ??
        payload.point,
        0,
        payload
    );

    if (!origin) {
        throw createError(
            "A valid origin point is required.",
            "MAP_WORKER_ORIGIN_REQUIRED",
            "TypeError"
        );
    }

    const bearingDegrees = number(
        payload.bearing ??
        payload.heading
    );

    if (bearingDegrees === null) {
        throw createError(
            "A numeric bearing is required.",
            "MAP_WORKER_BEARING_REQUIRED",
            "TypeError"
        );
    }

    const meters = distanceToMeters(
        payload.distanceMeters ??
        payload.distance_meters ??
        payload.distance ??
        0,
        payload.unit ??
        payload.units ??
        "meters"
    );

    if (meters < 0) {
        throw createError(
            "Distance must be non-negative.",
            "MAP_WORKER_INVALID_DISTANCE",
            "RangeError"
        );
    }

    return {
        origin,
        bearing: normalizeBearing(bearingDegrees),
        distanceMeters: meters,
        destination: destinationPoint(
            origin,
            meters,
            bearingDegrees
        )
    };
}

async function within(payload = {}, id = null) {
    const startedAt = now();
    const center = normalizePoint(
        payload.center ??
        payload.origin,
        0,
        payload
    );

    if (!center) {
        throw createError(
            "A valid center point is required.",
            "MAP_WORKER_CENTER_REQUIRED",
            "TypeError"
        );
    }

    const radiusMeters = distanceToMeters(
        payload.radiusMeters ??
        payload.radius_meters ??
        payload.radius ??
        0,
        payload.unit ??
        payload.units ??
        "meters"
    );

    if (radiusMeters < 0) {
        throw createError(
            "Radius must be non-negative.",
            "MAP_WORKER_INVALID_RADIUS",
            "RangeError"
        );
    }

    const normalized = await normalizePoints(
        extractPoints(payload),
        payload,
        id
    );

    const results = [];

    for (
        let index = 0;
        index < normalized.points.length;
        index += 1
    ) {
        assertActive(id);

        const point = normalized.points[index];
        const meters = haversine(center, point);

        if (meters <= radiusMeters) {
            results.push({
                point,
                distanceMeters: meters,
                distanceKilometers: meters / 1000,
                distanceMiles: meters / 1609.344
            });
        }

        if (
            boolean(payload.progress, false) &&
            index > 0 &&
            index % DEFAULT_PROGRESS_INTERVAL === 0
        ) {
            progress(
                id,
                "within",
                index,
                normalized.points.length,
                {
                    matches: results.length
                }
            );
        }

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    results.sort(
        (left, right) =>
            left.distanceMeters - right.distanceMeters
    );

    const limit = integer(
        payload.limit,
        MAX_LIMIT,
        1,
        MAX_LIMIT
    );

    return {
        center,
        radiusMeters,
        radiusKilometers: radiusMeters / 1000,
        totalPoints: normalized.points.length,
        invalid: normalized.invalid,
        matches: results.length,
        results: results.slice(0, limit),
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
    };
}

async function nearest(payload = {}, id = null) {
    const startedAt = now();
    const center = normalizePoint(
        payload.center ??
        payload.origin ??
        payload.point,
        0,
        payload
    );

    if (!center) {
        throw createError(
            "A valid center point is required.",
            "MAP_WORKER_CENTER_REQUIRED",
            "TypeError"
        );
    }

    const normalized = await normalizePoints(
        extractPoints(payload),
        payload,
        id
    );

    const limit = integer(
        payload.limit ??
        payload.count ??
        payload.k,
        1,
        1,
        MAX_LIMIT
    );

    const maximumDistance = payload.maximumDistance ??
        payload.maximum_distance ??
        payload.radius ??
        null;

    const maximumMeters = maximumDistance === null
        ? null
        : distanceToMeters(
            maximumDistance,
            payload.unit ??
            payload.units ??
            "meters"
        );

    const results = [];

    for (
        let index = 0;
        index < normalized.points.length;
        index += 1
    ) {
        assertActive(id);

        const point = normalized.points[index];
        const meters = haversine(center, point);

        if (
            maximumMeters !== null &&
            meters > maximumMeters
        ) {
            continue;
        }

        results.push({
            point,
            distanceMeters: meters,
            distanceKilometers: meters / 1000,
            distanceMiles: meters / 1609.344
        });

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    results.sort(
        (left, right) =>
            left.distanceMeters - right.distanceMeters
    );

    return {
        center,
        totalPoints: normalized.points.length,
        invalid: normalized.invalid,
        returned: Math.min(limit, results.length),
        results: results.slice(0, limit),
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
    };
}

async function withinBounds(payload = {}, id = null) {
    const normalized = await normalizePoints(
        extractPoints(payload),
        payload,
        id
    );

    const source =
        payload.bounds ??
        payload.bbox ??
        payload.box ??
        payload;

    const north = normalizeLatitude(
        source.north ??
        source.maxLat ??
        source.max_lat
    );

    const south = normalizeLatitude(
        source.south ??
        source.minLat ??
        source.min_lat
    );

    const east = normalizeLongitude(
        source.east ??
        source.maxLng ??
        source.max_lng ??
        source.maxLon ??
        source.max_lon
    );

    const west = normalizeLongitude(
        source.west ??
        source.minLng ??
        source.min_lng ??
        source.minLon ??
        source.min_lon
    );

    if (
        north === null ||
        south === null ||
        east === null ||
        west === null
    ) {
        throw createError(
            "Valid north, south, east, and west bounds are required.",
            "MAP_WORKER_BOUNDS_REQUIRED",
            "TypeError"
        );
    }

    if (south > north) {
        throw createError(
            "South latitude cannot be greater than north latitude.",
            "MAP_WORKER_INVALID_BOUNDS",
            "RangeError"
        );
    }

    const crossesAntimeridian =
        boolean(
            source.crossesAntimeridian ??
            source.crosses_antimeridian,
            west > east
        );

    const matches = [];

    for (
        let index = 0;
        index < normalized.points.length;
        index += 1
    ) {
        assertActive(id);

        const point = normalized.points[index];
        const latitudeMatch =
            point.lat >= south &&
            point.lat <= north;

        const longitudeMatch = crossesAntimeridian
            ? point.lng >= west || point.lng <= east
            : point.lng >= west && point.lng <= east;

        if (latitudeMatch && longitudeMatch) {
            matches.push(point);
        }

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    return {
        bounds: {
            north,
            south,
            east,
            west,
            crossesAntimeridian
        },
        totalPoints: normalized.points.length,
        invalid: normalized.invalid,
        matches: matches.length,
        points: matches
    };
}

async function toGeoJSON(payload = {}, id = null) {
    const normalized = await normalizePoints(
        extractPoints(payload),
        payload,
        id
    );

    const propertyFields = asArray(
        payload.propertyFields ??
        payload.property_fields
    ).map(text).filter(Boolean);

    const features = [];

    for (
        let index = 0;
        index < normalized.points.length;
        index += 1
    ) {
        assertActive(id);

        const point = normalized.points[index];
        const properties = {};

        if (propertyFields.length) {
            for (const field of propertyFields) {
                properties[field] = pathValue(point, field);
            }
        } else {
            for (const [name, value] of Object.entries(point)) {
                if (!["lat", "lng"].includes(name)) {
                    properties[name] = value;
                }
            }
        }

        features.push({
            type: "Feature",
            id:
                point.id ??
                point.speciedex_id ??
                point.speciedexId ??
                index,
            geometry: {
                type: "Point",
                coordinates: [
                    point.lng,
                    point.lat
                ]
            },
            properties
        });

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    return {
        type: "FeatureCollection",
        features,
        metadata: {
            valid: normalized.valid,
            invalid: normalized.invalid,
            generatedAt: new Date().toISOString(),
            workerVersion: WORKER_VERSION
        }
    };
}

function distanceToMeters(value, unit = "meters") {
    const amount = number(value, 0);
    const normalized = key(unit);

    switch (normalized) {
        case "meter":
        case "meters":
        case "m":
            return amount;

        case "kilometer":
        case "kilometers":
        case "km":
            return amount * 1000;

        case "mile":
        case "miles":
        case "mi":
            return amount * 1609.344;

        case "nautical-mile":
        case "nautical-miles":
        case "nauticalmile":
        case "nauticalmiles":
        case "nm":
            return amount * 1852;

        case "foot":
        case "feet":
        case "ft":
            return amount * 0.3048;

        default:
            throw createError(
                `Unsupported distance unit: ${unit}`,
                "MAP_WORKER_UNSUPPORTED_UNIT",
                "TypeError"
            );
    }
}

function haversine(left, right) {
    const lat1 = toRadians(left.lat);
    const lat2 = toRadians(right.lat);
    const latDelta = lat2 - lat1;
    const lngDelta = toRadians(
        normalizeLongitude(right.lng - left.lng)
    );

    const value =
        Math.sin(latDelta / 2) ** 2 +
        Math.cos(lat1) *
        Math.cos(lat2) *
        Math.sin(lngDelta / 2) ** 2;

    const bounded = Math.min(1, Math.max(0, value));

    return EARTH_RADIUS_METERS * (
        2 * Math.atan2(
            Math.sqrt(bounded),
            Math.sqrt(1 - bounded)
        )
    );
}

function initialBearing(left, right) {
    const lat1 = toRadians(left.lat);
    const lat2 = toRadians(right.lat);
    const lngDelta = toRadians(
        normalizeLongitude(right.lng - left.lng)
    );

    const y = Math.sin(lngDelta) * Math.cos(lat2);
    const x =
        Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) *
        Math.cos(lat2) *
        Math.cos(lngDelta);

    return normalizeBearing(
        toDegrees(Math.atan2(y, x))
    );
}

function finalBearing(left, right) {
    return normalizeBearing(
        initialBearing(right, left) + 180
    );
}

function normalizeBearing(value) {
    return ((Number(value) % 360) + 360) % 360;
}

function destinationPoint(origin, meters, bearingDegrees) {
    const angularDistance =
        meters / EARTH_RADIUS_METERS;

    const bearingRadians =
        toRadians(bearingDegrees);

    const latitude1 =
        toRadians(origin.lat);

    const longitude1 =
        toRadians(origin.lng);

    const latitude2 = Math.asin(
        Math.sin(latitude1) *
        Math.cos(angularDistance) +
        Math.cos(latitude1) *
        Math.sin(angularDistance) *
        Math.cos(bearingRadians)
    );

    const longitude2 =
        longitude1 +
        Math.atan2(
            Math.sin(bearingRadians) *
            Math.sin(angularDistance) *
            Math.cos(latitude1),
            Math.cos(angularDistance) -
            Math.sin(latitude1) *
            Math.sin(latitude2)
        );

    return {
        lat: toDegrees(latitude2),
        lng: normalizeLongitude(
            toDegrees(longitude2)
        )
    };
}

function toRadians(value) {
    return Number(value) * Math.PI / 180;
}

function toDegrees(value) {
    return Number(value) * 180 / Math.PI;
}
