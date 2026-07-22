# SpeciedexTerminal Provider Modules

Provider modules expose operational, statistical, documentation, overlap, latency, health, and ingestion views for configured taxonomic data providers.

## Files

### `terminal-eligible-providers.js`

List providers eligible for ingestion.

### `terminal-enabled-providers.js`

List providers enabled in the current build.

### `terminal-provider-assertions.js`

Inspect assertions grouped by provider.

### `terminal-provider-documentation.js`

Read provider documentation metadata.

### `terminal-provider-errors.js`

Inspect provider ingestion and validation errors.

### `terminal-provider-latency.js`

Inspect provider response and ingestion latency.

### `terminal-provider-overlap.js`

Compare record overlap between providers.

### `terminal-provider-species.js`

List species associated with a provider.

### `terminal-provider-statistics.js`

Display provider-level statistics.

### `terminal-providers.js`

List and search all configured providers.

## Runtime Integration

Modules register themselves on `window.SpeciedexTerminalModules` and expose a named global for direct access. The main `speciedex-terminal.js` application wrapper discovers these exports, initializes them in dependency order, and passes each module the shared terminal context.

## Data and Safety

The modules do not embed credentials. API access uses same-origin requests through the shared terminal API client. Worker scripts receive structured messages and return structured results. Optional failures are surfaced to the terminal without preventing unrelated modules from loading.
