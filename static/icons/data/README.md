# Data Icons

This directory contains compact interface icons for data actions and states:
import, export, database, archive, checksum, provider, record, statistics,
table, tree, map, graph, and status operations.

`manifest.json` catalogs each icon's stable semantic name, path, dimensions,
format, purpose, and aliases. Code should resolve icons through the manifest
where possible.

These are interface assets, not deterministic taxonomic icons. Taxonomic icons
belong in `static/images/taxa/`. Use stable lowercase filenames, transparent
PNG output unless another format is required, and update the manifest whenever
an asset is added, removed, or renamed.
