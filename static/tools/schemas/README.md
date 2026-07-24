# Provider Schemas

This directory contains one JSON schema or schema definition per provider.
Schemas define accepted structures, required and optional fields, types,
identifiers, pagination/archive metadata, and known variants before records
enter normalization.

Provider identifiers must match adapters, policies, examples, tests, and
documentation. `gbif.schema.json` retains a schema-specific filename while most
others use the provider identifier directly. Validation must produce useful
rejections and must not silently coerce unrelated structures. Never store
credentials.
