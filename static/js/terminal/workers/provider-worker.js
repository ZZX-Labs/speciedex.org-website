/*
========================================================================
Speciedex.org
Provider Worker
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
    const providers = Array.isArray(payload.providers) ? payload.providers : [];
    if (type === "health") {
        return providers.map(provider => ({
            id: provider.id || provider.name,
            enabled: provider.enabled !== false,
            status: provider.status || "unknown",
            latency: Number(provider.latency || 0),
            errors: Number(provider.errors || 0)
        }));
    }
    if (type === "overlap") {
        const [left, right] = payload.records || [[], []];
        const key = payload.key || "id";
        const rightIds = new Set((right || []).map(record => record?.[key]));
        return (left || []).filter(record => rightIds.has(record?.[key]));
    }
    throw new Error(`Unsupported provider operation: ${type}`);
}
