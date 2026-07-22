# SpeciedexTerminal Modules

This directory contains the browser-side modules used by SpeciedexTerminal. The runtime is divided into foundation services, interface controllers, renderers, data services, archive commands, provider commands, taxonomic commands, visualization modules, and Web Workers.

## Files

### `terminal-api.js`

Implements the terminal api service, controller, renderer, or command module.

### `terminal-bookmarks.js`

Implements the terminal bookmarks service, controller, renderer, or command module.

### `terminal-charts.js`

Implements the terminal charts service, controller, renderer, or command module.

### `terminal-console.js`

Implements the terminal console service, controller, renderer, or command module.

### `terminal-contextmenu.js`

Implements the terminal contextmenu service, controller, renderer, or command module.

### `terminal-events.js`

Implements the terminal events service, controller, renderer, or command module.

### `terminal-export.js`

Implements the terminal export service, controller, renderer, or command module.

### `terminal-graphs.js`

Implements the terminal graphs service, controller, renderer, or command module.

### `terminal-grid.js`

Implements the terminal grid service, controller, renderer, or command module.

### `terminal-heatmap.js`

Implements the terminal heatmap service, controller, renderer, or command module.

### `terminal-help.js`

Implements the terminal help service, controller, renderer, or command module.

### `terminal-history.js`

Implements the terminal history service, controller, renderer, or command module.

### `terminal-import.js`

Implements the terminal import service, controller, renderer, or command module.

### `terminal-index.js`

Implements the terminal index service, controller, renderer, or command module.

### `terminal-keyboard.js`

Implements the terminal keyboard service, controller, renderer, or command module.

### `terminal-layout.js`

Implements the terminal layout service, controller, renderer, or command module.

### `terminal-library.js`

Implements the terminal library service, controller, renderer, or command module.

### `terminal-lists.js`

Implements the terminal lists service, controller, renderer, or command module.

### `terminal-loading.js`

Implements the terminal loading service, controller, renderer, or command module.

### `terminal-log.js`

Implements the terminal log service, controller, renderer, or command module.

### `terminal-map.js`

Implements the terminal map service, controller, renderer, or command module.

### `terminal-matrix.js`

Implements the terminal matrix service, controller, renderer, or command module.

### `terminal-notifications.js`

Implements the terminal notifications service, controller, renderer, or command module.

### `terminal-progress.js`

Implements the terminal progress service, controller, renderer, or command module.

### `terminal-provider-health.js`

Implements the terminal provider health service, controller, renderer, or command module.

### `terminal-provider-manager.js`

Implements the terminal provider manager service, controller, renderer, or command module.

### `terminal-recent.js`

Implements the terminal recent service, controller, renderer, or command module.

### `terminal-router.js`

Implements the terminal router service, controller, renderer, or command module.

### `terminal-scan.js`

Implements the terminal scan service, controller, renderer, or command module.

### `terminal-search.js`

Implements the terminal search service, controller, renderer, or command module.

### `terminal-settings.js`

Implements the terminal settings service, controller, renderer, or command module.

### `terminal-state.js`

Implements the terminal state service, controller, renderer, or command module.

### `terminal-stats.js`

Implements the terminal stats service, controller, renderer, or command module.

### `terminal-statusbar.js`

Implements the terminal statusbar service, controller, renderer, or command module.

### `terminal-storage.js`

Implements the terminal storage service, controller, renderer, or command module.

### `terminal-stream.js`

Implements the terminal stream service, controller, renderer, or command module.

### `terminal-table.js`

Implements the terminal table service, controller, renderer, or command module.

### `terminal-tags.js`

Implements the terminal tags service, controller, renderer, or command module.

### `terminal-theme.js`

Implements the terminal theme service, controller, renderer, or command module.

### `terminal-timeline.js`

Implements the terminal timeline service, controller, renderer, or command module.

### `terminal-toolbar.js`

Implements the terminal toolbar service, controller, renderer, or command module.

### `terminal-tree.js`

Implements the terminal tree service, controller, renderer, or command module.

### `terminal-windows.js`

Implements the terminal windows service, controller, renderer, or command module.

### `speciedex-terminal.js`

Primary application wrapper that discovers, initializes, and coordinates every terminal module.

## Runtime Integration

Modules register themselves on `window.SpeciedexTerminalModules` and expose a named global for direct access. The main `speciedex-terminal.js` application wrapper discovers these exports, initializes them in dependency order, and passes each module the shared terminal context.

## Data and Safety

The modules do not embed credentials. API access uses same-origin requests through the shared terminal API client. Worker scripts receive structured messages and return structured results. Optional failures are surfaced to the terminal without preventing unrelated modules from loading.
