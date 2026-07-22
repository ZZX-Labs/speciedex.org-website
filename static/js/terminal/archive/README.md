# SpeciedexTerminal Archive Modules

Archive modules expose commands for immutable dataset volumes, release manifests, checksums, assertions, synonyms, conflicts, and publication history.

## Files

### `terminal-archive-history.js`

Display archive publication history.

### `terminal-checksums.js`

Inspect archive checksums and integrity records.

### `terminal-last-updated.js`

Display archive and provider update timestamps.

### `terminal-manifests.js`

Inspect archive manifests.

### `terminal-records-archived.js`

Display canonical archived record totals.

### `terminal-releases.js`

List Speciedex archive releases.

### `terminal-source-assertions.js`

Inspect source assertion records.

### `terminal-synonyms.js`

Search archived taxonomic synonyms.

### `terminal-unresolved-conflicts.js`

Inspect unresolved provider conflicts.

### `terminal-volumes.js`

List archive volumes and metadata.

## Runtime Integration

Modules register themselves on `window.SpeciedexTerminalModules` and expose a named global for direct access. The main `speciedex-terminal.js` application wrapper discovers these exports, initializes them in dependency order, and passes each module the shared terminal context.

## Data and Safety

The modules do not embed credentials. API access uses same-origin requests through the shared terminal API client. Worker scripts receive structured messages and return structured results. Optional failures are surfaced to the terminal without preventing unrelated modules from loading.
