/*
========================================================================
Speciedex.org
Statistics Worker
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
    if (type !== "calculate") throw new Error(`Unsupported statistics operation: ${type}`);
    const records = Array.isArray(payload.records) ? payload.records : [];
    const fields = payload.fields?.length
        ? payload.fields
        : [...new Set(records.flatMap(record => Object.keys(record || {})))];
    const distinct = {};
    for (const field of fields) {
        distinct[field] = new Set(records.map(record => record?.[field]).filter(value => value !== undefined)).size;
    }
    return {
        records: records.length,
        fields: fields.length,
        distinct
    };
}
