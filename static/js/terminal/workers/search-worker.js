/*
========================================================================
Speciedex.org
Search Worker
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
    if (type !== "search") throw new Error(`Unsupported search operation: ${type}`);
    const records = Array.isArray(payload.records) ? payload.records : [];
    const query = String(payload.query || "").trim().toLowerCase();
    const limit = Number(payload.limit) || 50;
    const fields = payload.fields?.length
        ? payload.fields
        : [...new Set(records.flatMap(record => Object.keys(record || {})))];
    if (!query) return records.slice(0, limit);
    const terms = query.split(/\s+/).filter(Boolean);
    return records.filter(record => {
        const haystack = fields.map(field => String(record?.[field] ?? "").toLowerCase()).join(" ");
        return terms.every(term => haystack.includes(term));
    }).slice(0, limit);
}
