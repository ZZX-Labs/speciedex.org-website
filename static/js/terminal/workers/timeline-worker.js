/*
========================================================================
Speciedex.org
Timeline Worker
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
    if (type !== "timeline") throw new Error(`Unsupported timeline operation: ${type}`);
    const field = payload.field || "date";
    const bucket = payload.bucket || "year";
    const records = Array.isArray(payload.records) ? payload.records : [];
    const counts = new Map();
    for (const record of records) {
        const date = new Date(record?.[field]);
        if (Number.isNaN(date.getTime())) continue;
        const key = bucket === "month"
            ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
            : String(date.getUTCFullYear());
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({ date, count }));
}
