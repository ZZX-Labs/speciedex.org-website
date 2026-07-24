# Taxonomy Volumes

This directory contains publication-sized canonical taxonomy volumes. Volumes are deterministic, segmented JSONL products derived from normalized and reconciled taxonomy records.

## Current file

- `species-000001.jsonl` — first species volume segment.

## Purpose

Volumes provide a portable archival and interchange representation independent of SQLite and MariaDB. They support release packaging, checksum verification, downstream imports, reproducibility, and recovery.

## Naming

```text
<rank-or-collection>-<six-digit-sequence>.jsonl
```

Examples:

```text
species-000001.jsonl
species-000002.jsonl
genera-000001.jsonl
all-taxa-000001.jsonl
```

## Rules

- One canonical JSON object per line.
- Deterministic ordering, preferably by stable `speciedex_id`.
- UTF-8 with normalized line endings.
- Each segment must remain below the repository file-size limit.
- Published volumes are immutable. Corrections produce revisions and a new release/volume set.
- Every volume must be represented in archive/database manifests and checksums.

## Relationship to databases

```text
normalized + reconciled taxonomy
        ├── volumes/*.jsonl
        ├── static/data/db/sqlite/*.sqlite3
        └── static/data/db/mariadb/*.sql.gz
```

All three products must describe the same canonical record set. `verify-database-parity.py`, shard verification, volume checksums, and record totals enforce this consistency.

The browser terminal should query SQLite shards and indexes rather than downloading every volume for each search.
