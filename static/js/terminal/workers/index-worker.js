/*
========================================================================
Speciedex.org
Index Worker
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

let documents = [];
let fields = [];
async function handle(type, payload) {
    if (type === "build") {
        documents = Array.isArray(payload.records) ? payload.records : [];
        fields = payload.fields?.length
            ? payload.fields
            : [...new Set(documents.flatMap(record => Object.keys(record || {})))];
        return { documents: documents.length, fields };
    }
    if (type === "search") {
        const query = String(payload.query || "").toLowerCase();
        const limit = Number(payload.limit) || 50;
        return documents.filter(record =>
            fields.some(field => String(record?.[field] ?? "").toLowerCase().includes(query))
        ).slice(0, limit);
    }
    if (type === "clear") {
        documents = [];
        fields = [];
        return true;
    }
    throw new Error(`Unsupported index operation: ${type}`);
}
