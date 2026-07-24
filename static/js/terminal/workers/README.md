# SpeciedexTerminal Web Workers

This directory contains the dedicated workers used to keep expensive terminal operations off the browser main thread. Workers communicate only through structured-cloneable messages and must never read or modify DOM objects.

## Files

| File | Responsibility |
|---|---|
| `filter-worker.js` | Applies structured filters and reports filter status. |
| `index-worker.js` | Builds, rebuilds, clears, searches, and reports the status of in-memory indexes. |
| `library-worker.js` | Maintains local library collections, filtering, clearing, and collection statistics. |
| `map-worker.js` | Normalizes and aggregates geographic records for map visualizations. |
| `provider-worker.js` | Performs provider comparison and aggregation work. |
| `search-worker.js` | Builds/searches the terminal search index and handles provider, conservation, and taxonomic fields. |
| `statistics-worker.js` | Calculates aggregate statistics away from the main thread. |
| `timeline-worker.js` | Produces normalized timeline data and timeline status. |

## Message contract

Workers should accept messages shaped like:

```javascript
{
    id: "request-id",
    type: "search",
    payload: {},
    options: {}
}
```

Responses should preserve the request identifier:

```javascript
{
    id: "request-id",
    type: "result",
    ok: true,
    result: {},
    error: null
}
```

Unhandled failures must be returned as serializable error objects. A worker must not terminate the entire terminal because one request failed.

## Database integration

The browser data path should be:

```text
static/js/data.js
    ↓ loads database and shard manifests
index/search worker
    ↓ selects or queries SQLite shards
terminal search/library/statistics services
    ↓
terminal commands and visualizations
```

Workers must not attempt to connect directly to MariaDB. MariaDB files are logical exports for server import and parity validation. Browser access uses SQLite/WebAssembly or prebuilt JSON indexes.

## Performance and safety

- Transfer large `ArrayBuffer` objects where possible instead of copying them.
- Bound result sizes and indexing memory.
- Support explicit `clear`/teardown operations.
- Ignore stale responses after a newer request supersedes them.
- Validate operation names and payload structure.
- Never use `eval`, dynamic code generation, credentials, or provider secrets.

## Validation requirements

```bash
node --check static/js/terminal/workers/*.js
```

Functional tests must cover build, search, filter, status, clear, malformed messages, duplicate request identifiers, cancellation/staleness, and empty database manifests.
