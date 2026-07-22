# SpeciedexTerminal Taxonomic Modules

Taxonomic modules provide rank-specific search and inspection commands across the canonical Speciedex taxonomy.

## Files

### `terminal-clades.js`

Search taxonomic clades.

### `terminal-classes.js`

Search taxonomic classes.

### `terminal-domains.js`

Search taxonomic domains.

### `terminal-families.js`

Search taxonomic families.

### `terminal-forms.js`

Search taxonomic forms.

### `terminal-genera.js`

Search taxonomic genera.

### `terminal-kingdoms.js`

Search taxonomic kingdoms.

### `terminal-orders.js`

Search taxonomic orders.

### `terminal-phyla.js`

Search taxonomic phyla.

### `terminal-ranks.js`

List supported taxonomic ranks.

### `terminal-species.js`

Search canonical species records.

### `terminal-subspecies.js`

Search canonical subspecies records.

### `terminal-tribes.js`

Search taxonomic tribes.

### `terminal-varieties.js`

Search taxonomic varieties.

## Runtime Integration

Modules register themselves on `window.SpeciedexTerminalModules` and expose a named global for direct access. The main `speciedex-terminal.js` application wrapper discovers these exports, initializes them in dependency order, and passes each module the shared terminal context.

## Data and Safety

The modules do not embed credentials. API access uses same-origin requests through the shared terminal API client. Worker scripts receive structured messages and return structured results. Optional failures are surfaced to the terminal without preventing unrelated modules from loading.
