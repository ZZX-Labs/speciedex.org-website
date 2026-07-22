/*
========================================================================
Speciedex.org
Map Worker
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

"use strict";

function respond(id, result, error = null) {
    self.postMessage(error ? {
        id,
        error: {
            name: error.name || "Error",
            message: error.message || String(error)
        }
    } : { id, result });
}

self.addEventListener("message", async event => {
    const message = event.data || {};
    const id = message.id;
    try {
        const result = await handle(message.type, message.payload || {});
        respond(id, result);
    } catch (error) {
        respond(id, null, error);
    }
});

async function handle(type, payload) {
    if (type === "bounds") {
        const points = (payload.points || []).filter(point =>
            Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng))
        );
        if (!points.length) return null;
        return {
            north: Math.max(...points.map(point => Number(point.lat))),
            south: Math.min(...points.map(point => Number(point.lat))),
            east: Math.max(...points.map(point => Number(point.lng))),
            west: Math.min(...points.map(point => Number(point.lng)))
        };
    }
    if (type === "cluster") {
        const precision = Number(payload.precision) || 1;
        const clusters = new Map();
        for (const point of payload.points || []) {
            const key = `${Number(point.lat).toFixed(precision)},${Number(point.lng).toFixed(precision)}`;
            if (!clusters.has(key)) clusters.set(key, []);
            clusters.get(key).push(point);
        }
        return [...clusters.entries()].map(([key, points]) => ({ key, points }));
    }
    throw new Error(`Unsupported map operation: ${type}`);
}
