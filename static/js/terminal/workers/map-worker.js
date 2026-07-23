/*
========================================================================
Speciedex.org
Map Worker
========================================================================

High-performance worker-side geospatial analysis for SpeciedexTerminal.

Supports coordinate normalization, antimeridian-aware bounds, clustering,
centroids, distance calculations, radius filtering, cancellation, progress
events, and structured worker responses.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

"use strict";

const WORKER_VERSION = "2.0.0";
const EARTH_RADIUS_METERS = 6371008.8;
const MAX_POINTS = 1000000;
const PROGRESS_INTERVAL = 5000;
const activeRequests = new Map();

function text(value) {
    return String(value ?? "").trim();
}

function number(value, fallback = null) {
    const result = Number(value);
    return Number.isFinite(result) ? result : fallback;
}

function integer(value, fallback, minimum, maximum) {
    const result = Number.parseInt(value, 10);
    return Number.isFinite(result)
        ? Math.min(maximum, Math.max(minimum, result))
        : fallback;
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
    self.postMessage({ type, id, ...payload });
}

function respond(id, result, error = null) {
    send("response", id, error
        ? { error: serializeError(error) }
        : { result });
}

function assertActive(id) {
    if (id !== null && activeRequests.get(id)?.cancelled) {
        const error = new Error("Map worker request cancelled.");
        error.name = "AbortError";
        error.code = "MAP_WORKER_CANCELLED";
        throw error;
    }
}

self.addEventListener("message", async event => {
    const message = event.data || {};
    const id = message.id ?? null;
    const type = text(message.type).toLowerCase();

    if (type === "cancel") {
        const targetId = message.payload?.id ?? message.targetId ?? id;
        if (activeRequests.has(targetId)) {
            activeRequests.get(targetId).cancelled = true;
        }
        respond(id, { cancelled: true, targetId });
        return;
    }

    activeRequests.set(id, {
        cancelled: false,
        startedAt: performance.now()
    });

    try {
        respond(id, await handle(type, message.payload || {}, id));
    } catch (error) {
        respond(id, null, error);
    } finally {
        activeRequests.delete(id);
    }
});

async function handle(type, payload, id) {
    switch (type) {
        case "bounds":
            return bounds(payload, id);
        case "cluster":
            return cluster(payload, id);
        case "centroid":
            return centroid(payload, id);
        case "distance":
            return distance(payload);
        case "within":
        case "radius":
            return within(payload, id);
        case "normalize":
            return normalizePoints(payload.points, payload, id);
        case "status":
            return {
                ready: true,
                workerVersion: WORKER_VERSION,
                activeRequests: activeRequests.size
            };
        case "ping":
            return { pong: true, version: WORKER_VERSION };
        default:
            throw new Error(`Unsupported map operation: ${type || "(empty)"}`);
    }
}

function latitude(point) {
    return point && typeof point === "object"
        ? number(point.lat ?? point.latitude ?? point.y)
        : null;
}

function longitude(point) {
    return point && typeof point === "object"
        ? number(point.lng ?? point.lon ?? point.long ?? point.longitude ?? point.x)
        : null;
}

function normalizeLongitude(value) {
    const lng = number(value);
    return lng === null
        ? null
        : (((lng + 180) % 360 + 360) % 360) - 180;
}

function normalizeLatitude(value) {
    const lat = number(value);
    return lat !== null && lat >= -90 && lat <= 90 ? lat : null;
}

function normalizePoint(point, index = 0) {
    const lat = normalizeLatitude(latitude(point));
    const lng = normalizeLongitude(longitude(point));

    if (lat === null || lng === null) {
        return null;
    }

    return {
        ...(point && typeof point === "object" ? point : {}),
        lat,
        lng,
        index: point?.index ?? index
    };
}

async function normalizePoints(points, options = {}, id = null) {
    const input = Array.isArray(points) ? points : [];

    if (input.length > MAX_POINTS) {
        throw new RangeError(
            `Map point limit exceeded: ${input.length} > ${MAX_POINTS}.`
        );
    }

    const valid = [];
    const invalid = [];

    for (let index = 0; index < input.length; index += 1) {
        assertActive(id);
        const point = normalizePoint(input[index], index);

        if (point) {
            valid.push(point);
        } else {
            invalid.push({ index, point: input[index] });
        }

        if (
            options.progress === true &&
            index > 0 &&
            index % PROGRESS_INTERVAL === 0
        ) {
            send("progress", id, {
                phase: "normalize",
                completed: index,
                total: input.length
            });
            await Promise.resolve();
        }
    }

    return {
        points: valid,
        valid: valid.length,
        invalid: invalid.length,
        rejected: options.includeRejected === true ? invalid : undefined
    };
}

async function bounds(payload = {}, id = null) {
    const normalized = await normalizePoints(payload.points, payload, id);
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
        .sort((a, b) => a - b);

    const normalWest = longitudes[0];
    const normalEast = longitudes[longitudes.length - 1];
    const normalSpan = normalEast - normalWest;

    let largestGap = -1;
    let largestGapIndex = -1;

    for (let index = 0; index < longitudes.length; index += 1) {
        const current = longitudes[index];
        const next = index === longitudes.length - 1
            ? longitudes[0] + 360
            : longitudes[index + 1];
        const gap = next - current;

        if (gap > largestGap) {
            largestGap = gap;
            largestGapIndex = index;
        }
    }

    const wrappedWest = normalizeLongitude(
        longitudes[(largestGapIndex + 1) % longitudes.length]
    );
    const wrappedEast = normalizeLongitude(longitudes[largestGapIndex]);
    const wrappedSpan = 360 - largestGap;
    const crossesAntimeridian = wrappedSpan < normalSpan;

    return {
        north,
        south,
        east: crossesAntimeridian ? wrappedEast : normalEast,
        west: crossesAntimeridian ? wrappedWest : normalWest,
        crossesAntimeridian,
        longitudeSpan: crossesAntimeridian ? wrappedSpan : normalSpan,
        latitudeSpan: north - south,
        center: sphericalCentroid(points),
        count: points.length,
        invalid: normalized.invalid
    };
}

function round(value, precision) {
    const factor = 10 ** precision;
    return Math.round(value * factor) / factor;
}

async function cluster(payload = {}, id = null) {
    const normalized = await normalizePoints(payload.points, payload, id);
    const precision = integer(payload.precision, 1, 0, 8);
    const includePoints = payload.includePoints !== false;
    const clusters = new Map();

    for (let index = 0; index < normalized.points.length; index += 1) {
        assertActive(id);
        const point = normalized.points[index];
        const latCell = round(point.lat, precision);
        const lngCell = round(point.lng, precision);
        const key = `${latCell.toFixed(precision)},${lngCell.toFixed(precision)}`;

        let value = clusters.get(key);
        if (!value) {
            value = {
                key,
                count: 0,
                points: [],
                latitudeTotal: 0,
                longitudeX: 0,
                longitudeY: 0,
                north: -90,
                south: 90,
                east: -180,
                west: 180
            };
            clusters.set(key, value);
        }

        value.count += 1;
        value.latitudeTotal += point.lat;

        const radians = toRadians(point.lng);
        value.longitudeX += Math.cos(radians);
        value.longitudeY += Math.sin(radians);
        value.north = Math.max(value.north, point.lat);
        value.south = Math.min(value.south, point.lat);
        value.east = Math.max(value.east, point.lng);
        value.west = Math.min(value.west, point.lng);

        if (includePoints) {
            value.points.push(point);
        }

        if (
            payload.progress === true &&
            index > 0 &&
            index % PROGRESS_INTERVAL === 0
        ) {
            send("progress", id, {
                phase: "cluster",
                completed: index,
                total: normalized.points.length
            });
            await Promise.resolve();
        }
    }

    const results = [...clusters.values()]
        .map(value => ({
            key: value.key,
            count: value.count,
            centroid: {
                lat: value.latitudeTotal / value.count,
                lng: normalizeLongitude(
                    toDegrees(Math.atan2(value.longitudeY, value.longitudeX))
                )
            },
            bounds: {
                north: value.north,
                south: value.south,
                east: value.east,
                west: value.west
            },
            points: includePoints ? value.points : undefined
        }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

    return {
        precision,
        points: normalized.points.length,
        invalid: normalized.invalid,
        clusters: results.length,
        results
    };
}

async function centroid(payload = {}, id = null) {
    const normalized = await normalizePoints(payload.points, payload, id);

    if (!normalized.points.length) {
        return null;
    }

    return {
        ...sphericalCentroid(normalized.points),
        count: normalized.points.length,
        invalid: normalized.invalid
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
        lat: toDegrees(Math.atan2(z, Math.sqrt(x * x + y * y))),
        lng: normalizeLongitude(toDegrees(Math.atan2(y, x)))
    };
}

function distance(payload = {}) {
    const from = normalizePoint(payload.from ?? payload.origin ?? payload.a);
    const to = normalizePoint(payload.to ?? payload.destination ?? payload.b);

    if (!from || !to) {
        throw new TypeError("Two valid map points are required.");
    }

    const meters = haversine(from, to);

    return {
        from,
        to,
        meters,
        kilometers: meters / 1000,
        miles: meters / 1609.344,
        nauticalMiles: meters / 1852
    };
}

async function within(payload = {}, id = null) {
    const center = normalizePoint(payload.center ?? payload.origin);

    if (!center) {
        throw new TypeError("A valid center point is required.");
    }

    const radiusMeters = number(
        payload.radiusMeters ??
        payload.radius_meters ??
        payload.radius,
        0
    );

    if (radiusMeters === null || radiusMeters < 0) {
        throw new RangeError("Radius must be a non-negative number.");
    }

    const normalized = await normalizePoints(payload.points, payload, id);
    const results = [];

    for (let index = 0; index < normalized.points.length; index += 1) {
        assertActive(id);
        const point = normalized.points[index];
        const meters = haversine(center, point);

        if (meters <= radiusMeters) {
            results.push({
                point,
                distanceMeters: meters,
                distanceKilometers: meters / 1000
            });
        }

        if (
            payload.progress === true &&
            index > 0 &&
            index % PROGRESS_INTERVAL === 0
        ) {
            send("progress", id, {
                phase: "within",
                completed: index,
                total: normalized.points.length
            });
            await Promise.resolve();
        }
    }

    results.sort((a, b) => a.distanceMeters - b.distanceMeters);

    return {
        center,
        radiusMeters,
        radiusKilometers: radiusMeters / 1000,
        totalPoints: normalized.points.length,
        invalid: normalized.invalid,
        matches: results.length,
        results
    };
}

function haversine(left, right) {
    const lat1 = toRadians(left.lat);
    const lat2 = toRadians(right.lat);
    const latDelta = lat2 - lat1;
    const lngDelta = toRadians(right.lng - left.lng);

    const value =
        Math.sin(latDelta / 2) ** 2 +
        Math.cos(lat1) *
        Math.cos(lat2) *
        Math.sin(lngDelta / 2) ** 2;

    return EARTH_RADIUS_METERS * (
        2 * Math.atan2(
            Math.sqrt(value),
            Math.sqrt(1 - value)
        )
    );
}

function toRadians(value) {
    return Number(value) * Math.PI / 180;
}

function toDegrees(value) {
    return Number(value) * 180 / Math.PI;
}
