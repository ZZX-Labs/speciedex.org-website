# Speciedex Provider Contract Schemas

Each `<provider>.schema.json` validates the normalized `Taxon.to_dict()` record emitted by that provider adapter. These schemas describe the Speciedex adapter contract and include upstream configuration metadata under `x-speciedex`. They do not assert that a third-party API has been live-verified. Live verification state remains in `static/tools/providers.json`.
