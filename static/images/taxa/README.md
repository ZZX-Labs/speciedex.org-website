# Deterministic Taxonomic Icons

This directory contains generated taxonomic icon products.

- `master/`: canonical full-resolution icons.
- `32/`, `64/`, `128/`, `256/`, `512/`: size derivatives.
- `sprites/`: packed sprite sheets.
- Metadata and lookup indexes: `static/data/icons/`.

The pipeline in `static/tools/icon-forge/` reads normalized taxonomy, enriches
stable visual parameters, renders masters, creates derivatives and sprites,
builds indexes, and verifies the result.

Filenames must derive from stable canonical identifiers, not display names.
Every master must have required derivatives, correct dimensions, valid PNG
content, matching hashes, valid sprite coordinates, and one unambiguous
manifest identity. This directory is generated output; manual changes will be
overwritten.
