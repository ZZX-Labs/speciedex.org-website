# SpeciedexTerminal Visualization Modules

Visualization modules translate terminal datasets into interactive or canvas-backed views. Each module registers both a visualization service and a terminal command.

## Files

### `terminal-cmatrix.js`

Registers the `cmatrix` renderer and command for CMatrix visualization output.

### `terminal-constellation.js`

Registers the `constellation` renderer and command for Constellation visualization output.

### `terminal-density.js`

Registers the `density` renderer and command for Density visualization output.

### `terminal-forcegraph.js`

Registers the `forcegraph` renderer and command for ForceGraph visualization output.

### `terminal-globe.js`

Registers the `globe` renderer and command for Globe visualization output.

### `terminal-heatmesh.js`

Registers the `heatmesh` renderer and command for HeatMesh visualization output.

### `terminal-hexmap.js`

Registers the `hexmap` renderer and command for HexMap visualization output.

### `terminal-network.js`

Registers the `network` renderer and command for Network visualization output.

### `terminal-phylogeny.js`

Registers the `phylogeny` renderer and command for Phylogeny visualization output.

### `terminal-provider-matrix.js`

Registers the `provider-matrix` renderer and command for ProviderMatrix visualization output.

### `terminal-radial.js`

Registers the `radial` renderer and command for Radial visualization output.

### `terminal-range-map.js`

Registers the `range-map` renderer and command for RangeMap visualization output.

### `terminal-sankey.js`

Registers the `sankey` renderer and command for Sankey visualization output.

### `terminal-streamgraph.js`

Registers the `streamgraph` renderer and command for StreamGraph visualization output.

### `terminal-taxonomy-tree.js`

Registers the `taxonomy-tree` renderer and command for TaxonomyTree visualization output.

### `terminal-time-slider.js`

Registers the `time-slider` renderer and command for TimeSlider visualization output.

### `terminal-wordcloud.js`

Registers the `wordcloud` renderer and command for WordCloud visualization output.

### `terminal-zmatrix.js`

Registers the `zmatrix` renderer and command for ZMatrix visualization output.

## Runtime Integration

Modules register themselves on `window.SpeciedexTerminalModules` and expose a named global for direct access. The main `speciedex-terminal.js` application wrapper discovers these exports, initializes them in dependency order, and passes each module the shared terminal context.

## Data and Safety

The modules do not embed credentials. API access uses same-origin requests through the shared terminal API client. Worker scripts receive structured messages and return structured results. Optional failures are surfaced to the terminal without preventing unrelated modules from loading.
