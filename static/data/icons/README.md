# Generated Icon Metadata

This directory contains machine-readable metadata for the deterministic
Speciedex taxonomic icon system. Rendered image files are stored under
`static/images/taxa/`.

- `icon-manifest.json` catalogs identifiers, ranks, source hashes, output paths,
  dimensions, and image hashes.
- `sprite-index.json` maps identifiers to sprite sheets and coordinates.
- `generation-report.json` records totals, warnings, rejected inputs, missing
  derivatives, and verification results.
- `SHA256SUMS` records checksums for generated icon products.

The files are produced by `static/tools/icon-forge/` and consumed by the site,
terminal, explorer, and icon lookup code. Consumers should resolve icons through
the manifest rather than scanning the image tree.

Every manifest entry must resolve to an existing valid PNG, match its recorded
hash, and identify a canonical taxon and rank. Sprite rectangles must remain
inside the declared sheet dimensions. Fatal generation or verification errors
must block publication.
