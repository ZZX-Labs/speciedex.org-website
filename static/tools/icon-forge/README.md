# Speciedex Icon Forge

This directory implements deterministic taxonomic icon generation.

- `fetch-taxonomy.py`: acquire icon input taxonomy.
- `normalize-taxonomy.py`: canonical icon inputs.
- `enrich-taxonomy.py`: lineage/rank-derived visual parameters.
- `build-icons.py`: master icon rendering.
- `build-icon-derivatives.py`: size variants.
- `build-sprites.py`: sprite sheets.
- `icon-index.py`: icon and sprite metadata.
- `verify-icons.py`: image, derivative, hash, manifest, and sprite checks.

Inputs come from `static/data/taxonomy/normalized/`; images go to
`static/images/taxa/`; metadata goes to `static/data/icons/`. Randomness must be
seeded from stable canonical data. Publication fails on missing derivatives,
invalid PNGs, mismatched hashes, or out-of-bounds sprite coordinates.
