/*
========================================================================
Speciedex.org
Library Worker
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

const collections = new Map();
async function handle(type, payload) {
    if (type === "set") {
        collections.set(payload.name, Array.isArray(payload.records) ? payload.records : []);
        return collections.get(payload.name).length;
    }
    if (type === "get") return collections.get(payload.name) || [];
    if (type === "list") {
        return [...collections.entries()].map(([name, records]) => ({
            name, records: records.length
        }));
    }
    if (type === "delete") return collections.delete(payload.name);
    if (type === "clear") {
        collections.clear();
        return true;
    }
    throw new Error(`Unsupported library operation: ${type}`);
}
