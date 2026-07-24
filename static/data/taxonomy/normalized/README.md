# Normalized Taxonomy Records

This directory contains records converted from provider-specific payloads into the canonical Speciedex taxonomy schema. These files are the primary inputs for enrichment, icon generation, conflict reconciliation, volume creation, and database shard generation.

## Current files

- `all-taxa.jsonl` — normalized canonical taxonomy records.
- `all-taxa-enriched.jsonl` — normalized records after enrichment and derived-field processing.
- `icon-queue.jsonl` — deterministic icon-generation queue derived from normalized taxa.

## Canonical record expectations

Every normalized record should contain a stable identity and enough metadata to support taxonomy search and provenance. Typical fields include:

```json
{
  "speciedex_id": "spx:...",
  "scientific_name": "Panthera leo",
  "canonical_name": "Panthera leo",
  "common_name": "Lion",
  "rank": "species",
  "status": "accepted",
  "provider": "provider-name",
  "source": "provider-name",
  "family": "Felidae",
  "genus": "Panthera",
  "indexed_at": "2026-07-24T12:00:00Z",
  "record_hash": "..."
}
```

## Invariants

- One JSON object per line for JSONL files.
- UTF-8 encoding and normalized Unicode.
- Stable `speciedex_id` values.
- Deterministic normalization for the same raw input and policy set.
- Provider provenance retained.
- No credentials or private source data.
- Rejected records must not appear here.
- Conflicting records may appear only with sufficient assertion/provenance metadata for reconciliation.

## Consumers

- `static/tools/icon-forge/`
- `static/tools/database/`
- revision and conflict tooling
- archive volume builders
- statistics generation

The public terminal should not scan these large JSONL files directly. It should query the SQLite shards and indexes generated beneath `static/data/db/`.
