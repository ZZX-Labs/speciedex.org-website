# SpeciedexTerminal Web Workers

These scripts perform CPU-intensive filtering, indexing, searching, statistics, provider comparison, mapping, library, and timeline operations away from the main browser thread.

## Files

### `filter-worker.js`

Background worker for filter processing.

### `index-worker.js`

Background worker for index processing.

### `library-worker.js`

Background worker for library processing.

### `map-worker.js`

Background worker for map processing.

### `provider-worker.js`

Background worker for provider processing.

### `search-worker.js`

Background worker for search processing.

### `statistics-worker.js`

Background worker for statistics processing.

### `timeline-worker.js`

Background worker for timeline processing.

## Runtime Integration

Modules register themselves on `window.SpeciedexTerminalModules` and expose a named global for direct access. The main `speciedex-terminal.js` application wrapper discovers these exports, initializes them in dependency order, and passes each module the shared terminal context.

## Data and Safety

The modules do not embed credentials. API access uses same-origin requests through the shared terminal API client. Worker scripts receive structured messages and return structured results. Optional failures are surfaced to the terminal without preventing unrelated modules from loading.
