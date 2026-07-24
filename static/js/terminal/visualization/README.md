# SpeciedexTerminal Visualization Modules

This directory contains the canvas, DOM, and data-driven visualization engines used by SpeciedexTerminal. Visualizations register through the shared terminal context and normally expose both a renderer/service and a terminal command.

## Files

| File | Purpose |
|---|---|
| `terminal-cmatrix.js` | C-style matrix rain renderer. This renderer is currently under active debugging because its behavior does not yet match the working ZMatrix engine. |
| `terminal-zmatrix.js` | Working Z-style matrix rain renderer and current reference implementation for lifecycle, resize, animation, injection, pause/resume, clear, and destroy behavior. |
| `terminal-wordcloud.js` | Collision-aware transparent word cloud. In the splash it must render over the active matrix canvas, not in a separate pane. Words come from newly indexed species and fade without obscuring the matrix background. |
| `terminal-splash.js` | Coordinates the live record list, active matrix renderer, CMatrix/ZMatrix toggle, transparent word cloud, visibility controls, events, and stream rotation. |
| `terminal-constellation.js` | Node constellation visualization. |
| `terminal-density.js` | Density visualization. |
| `terminal-forcegraph.js` | Force-directed graph. |
| `terminal-globe.js` | Geographic globe visualization. |
| `terminal-heatmesh.js` | Heat-mesh visualization. |
| `terminal-hexmap.js` | Hexagonal map visualization. |
| `terminal-network.js` | Provider/taxon network visualization. |
| `terminal-phylogeny.js` | Phylogenetic relationship visualization. |
| `terminal-provider-matrix.js` | Provider comparison matrix. |
| `terminal-radial.js` | Radial hierarchy/statistics view. |
| `terminal-range-map.js` | Species range map. |
| `terminal-sankey.js` | Sankey flow visualization. |
| `terminal-streamgraph.js` | Time-series stream graph. |
| `terminal-taxonomy-tree.js` | Taxonomy tree visualization. |
| `terminal-time-slider.js` | Timeline range and playback control. |

## Splash layer contract

The live splash is a single composite stage:

```text
terminal-splash-background
├── active matrix canvas             z-index 1
├── transparent word-cloud canvas    z-index 2
├── readability overlay              z-index 3
└── header/list/footer/controls       z-index 4
```

CMatrix and ZMatrix are mutually exclusive renderers mounted to the same matrix canvas. Switching modes must destroy the previous controller, mount the selected controller, preserve records, and keep pause/resume state synchronized.

The word cloud must receive terms from the same real-time record stream used by the splash list. It should include scientific names, common names, ranks, providers, statuses, and other configured fields.

## Required controller lifecycle

Every continuously running visualization must provide compatible methods where applicable:

```text
mount(target, options)
start()
stop()
pause()
resume()
resize()
clear()
status()
destroy()
```

Render loops must use `requestAnimationFrame`, cancel their frame on teardown, react to `ResizeObserver`, respect reduced-motion preferences, and avoid duplicate listeners or timers after remounting.

## Known debugging priorities

1. Bring `terminal-cmatrix.js` to functional parity with `terminal-zmatrix.js`.
2. Confirm the CMatrix/ZMatrix toggle mounts only one engine at a time.
3. Feed live database additions from `static/js/data.js` into `terminal-splash.js`.
4. Confirm the word cloud overlays the matrix and fades terms smoothly.
5. Correct the `0 records` indicators by connecting splash/statistics state to the generated database manifests and update stream.
6. Verify every visualization command can render into the terminal output without breaking command input or buttons.

## Validation requirements

```bash
node --check static/js/terminal/visualization/*.js
```

Runtime validation must additionally check animation cancellation, resize behavior, event-listener cleanup, hidden-page behavior, and repeated CMatrix/ZMatrix switching.
