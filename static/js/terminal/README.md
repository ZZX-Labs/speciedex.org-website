# SpeciedexTerminal JavaScript

This directory contains the complete browser runtime for the public
SpeciedexTerminal application. Together these modules implement an interactive
command-line interface for exploring the Speciedex taxonomy, SQLite database
shards, provider metadata, archive history, visualization engines, statistics,
and every browser-facing subsystem used by the website.

The runtime is modular. Every file registers itself with the shared terminal
runtime, receives the common terminal context, exposes its services through the
module registry, and communicates through the terminal event bus.

---

## Runtime Architecture

```text
speciedex-terminal.js
        │
        ▼
manifest.json
        │
        ▼
Module Loader
        │
        ▼
Shared Terminal Context
        │
        ├── API
        ├── State
        ├── Storage
        ├── Events
        ├── Router
        ├── Search
        ├── Database
        ├── Providers
        ├── Taxonomy
        ├── Visualization
        ├── Archive
        └── Workers
```

Every module registers itself with `window.SpeciedexTerminalModules`. The
application wrapper discovers registered modules, resolves dependencies,
initializes them in order, and exposes shared services through the terminal
context.

## Top-Level Modules

### terminal-api.js
Shared API client, request routing, retries, endpoint discovery, JSON parsing,
timeouts, cancellation, and browser-side database access.

### terminal-bookmarks.js
Saved searches, layouts, providers, visualizations, and bookmarked commands.

### terminal-charts.js
Chart rendering services for statistics and analytical output.

### terminal-console.js
Interactive console, prompt rendering, editing, history, completion, cursor,
submission, scrolling, and output integration.

### terminal-contextmenu.js
Context menus, clipboard operations, and contextual terminal actions.

### terminal-events.js
Central event bus and module messaging.

### terminal-export.js
Export commands for JSON, CSV, Markdown, HTML, and future formats.

### terminal-graphs.js
Graph rendering services.

### terminal-grid.js
Grid renderer and tabular layouts.

### terminal-heatmap.js
Heat map visualization engine.

### terminal-help.js
Help registry, usage documentation, and command discovery.

### terminal-history.js
Persistent command history and navigation.

### terminal-import.js
Import services for supported datasets.

### terminal-index.js
Browser index management and lookup routing.

### terminal-keyboard.js
Keyboard shortcuts, editing behavior, accessibility, and focus management.

### terminal-layout.js
Terminal layout management and responsive behavior.

### terminal-library.js
Library browsing and local dataset management.

### terminal-lists.js
List rendering helpers.

### terminal-loading.js
Loading tasks, splash state, initialization coordination, and loading UI.

### terminal-log.js
Logging, diagnostics, and runtime messages.

### terminal-map.js
Map rendering and geographic visualization.

### terminal-matrix.js
Shared matrix visualization controller.

### terminal-notifications.js
Notification manager.

### terminal-progress.js
Progress coordination, concurrent jobs, ETA, cancellation, aggregate progress,
and loading integration.

### terminal-provider-health.js
Provider health diagnostics.

### terminal-provider-manager.js
Provider enablement, configuration, synchronization, and management.

### terminal-recent.js
Recently viewed records and commands.

### terminal-router.js
Command routing for built-in, taxonomy, archive, visualization, and provider
commands.

### terminal-scan.js
Scanning and discovery services.

### terminal-search.js
Unified search across SQLite shards, taxonomy, archives, providers, and indexes.

### terminal-settings.js
Persistent user settings.

### terminal-state.js
Shared runtime state store for session, search, visualization, providers,
notifications, jobs, and configuration.

### terminal-stats.js
Statistics collection and reporting.

### terminal-statusbar.js
Status bar rendering.

### terminal-storage.js
Persistent browser storage abstraction.

### terminal-stream.js
Streaming updates and live feeds.

### terminal-table.js
Rich table renderer.

### terminal-tags.js
Tagging and metadata helpers.

### terminal-theme.js
Theme management.

### terminal-timeline.js
Timeline rendering.

### terminal-toolbar.js
Toolbar controls and actions.

### terminal-tree.js
Hierarchical tree renderer.

### terminal-windows.js
Window and panel management.

### speciedex-terminal.js
Primary application wrapper that discovers, initializes, and coordinates every
terminal module.

## Subdirectories

- **archive/** — archive history, releases, manifests, checksums, assertions,
  conflicts, revisions, and synonym history.
- **providers/** — provider health, enablement, statistics, documentation,
  overlap analysis, assertions, diagnostics, and synchronization.
- **taxa/** — rank-specific taxonomy commands and services.
- **visualization/** — CMatrix, ZMatrix, Word Cloud, Splash, Globe, Network,
  Force Graph, Heat Map, Density, Hex Map, Constellation, Timeline,
  Phylogeny, Time Slider, and related renderers.
- **workers/** — background SQLite searching, indexing, filtering, provider
  processing, statistics, library, map, and timeline workers.

## Database Integration

The browser never connects directly to MariaDB.

```text
77 Providers
      │
taxonomy/
      │
SQLite + MariaDB Builders
      │
Database Manifest
      │
Browser Indexes
      │
Worker Threads
      │
Terminal Search
      │
Visualizations
```

The terminal loads `static/data/db/manifest.json`, resolves browser indexes,
loads only required SQLite shards, merges cross-shard results, updates the
statistics, splash, search engine, and live word cloud, while MariaDB remains a
deployment and server-side format.

## Visualization

Exactly one matrix renderer (CMatrix or ZMatrix) owns the background canvas.
The word cloud is rendered as a transparent overlay above the matrix layer and
is populated from newly indexed species additions arriving through the update
stream.

## Runtime Lifecycle

1. Load manifest.
2. Discover modules.
3. Resolve dependencies.
4. Build shared context.
5. Initialize services.
6. Initialize workers.
7. Load database manifest.
8. Load browser indexes.
9. Initialize router.
10. Initialize visualizations.
11. Restore session state.
12. Present the interactive prompt.

## Production Requirements

A complete runtime must provide:

- working command routing
- functioning buttons and keyboard shortcuts
- SQLite-backed searching
- live database-derived statistics
- live species additions
- synchronized splash table
- transparent word cloud overlay
- interchangeable CMatrix and ZMatrix engines
- archive and provider commands
- clean startup and teardown
- accessibility support

Passing `node --check` is required but does not replace full browser integration
testing.
