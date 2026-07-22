/*
========================================================================
Speciedex.org
Filter Worker
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
    if (type !== "filter") throw new Error(`Unsupported filter operation: ${type}`);
    const records = Array.isArray(payload.records) ? payload.records : [];
    const filters = payload.filters || {};
    return records.filter(record => Object.entries(filters).every(([key, value]) => {
        const current = record?.[key];
        if (Array.isArray(value)) return value.includes(current);
        if (value && typeof value === "object") {
            if (value.min !== undefined && Number(current) < Number(value.min)) return false;
            if (value.max !== undefined && Number(current) > Number(value.max)) return false;
            return true;
        }
        return String(current ?? "").toLowerCase().includes(String(value).toLowerCase());
    }));
}
