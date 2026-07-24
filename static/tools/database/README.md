# Speciedex Database Build System

This directory contains the complete database generation, reconciliation,
verification, import, export, and maintenance pipeline for Speciedex.

The canonical source of truth is always:

```text
static/data/taxonomy/
```

Every database product is generated from that taxonomy.

SQLite, MariaDB, browser indexes, manifests, checksums, update streams,
statistics, reports, and terminal search data are all derived products.

Neither SQLite nor MariaDB is considered authoritative.

Any modification made to either database format must first be imported back into
the canonical taxonomy, reconciled, validated, and only then regenerated into
both database formats.

------------------------------------------------------------------------------

# Overall Pipeline

```text
                  77 Taxonomic Providers
                           │
                           ▼
                static/data/taxonomy/raw/
                           │
                           ▼
                    Validation & Mapping
                           │
                           ▼
                  Normalization Pipeline
                           │
                           ▼
                Duplicate Reconciliation
                           │
                           ▼
                Canonical Taxonomy Records
                           │
        ┌──────────────────┴──────────────────┐
        ▼                                     ▼
 SQLite Builder                       MariaDB Builder
        │                                     │
        └──────────────────┬──────────────────┘
                           ▼
                 Browser Search Indexes
                           │
                           ▼
                 Database Manifest Files
                           │
                           ▼
                  Terminal Search System
                           │
                           ▼
                  Website / Explorer / API
```

------------------------------------------------------------------------------

# Directory Responsibilities

This directory generates and maintains every database product under:

```text
static/data/db/
```

including

- SQLite shards
- MariaDB exports
- browser indexes
- routing tables
- manifests
- update streams
- parity reports
- checksums
- verification reports

------------------------------------------------------------------------------

# Programs

## build-databases.py

Primary build entry point.

Runs the complete database pipeline including

- SQLite generation
- MariaDB generation
- indexes
- manifests
- update streams
- verification
- checksums
- reports

Typical usage

```bash
python static/tools/database/build-databases.py
```

------------------------------------------------------------------------------

## update-databases.py

Incrementally rebuilds databases after new taxonomy records have been added.

Updates

- affected shards
- browser indexes
- manifests
- update streams
- statistics

without unnecessarily rebuilding unchanged products.

------------------------------------------------------------------------------

## build-sqlite-shards.py

Generates browser-queryable SQLite database shards.

Responsibilities include

- shard sizing
- schema creation
- index generation
- vacuum
- integrity checks
- shard manifests

Target shard size remains below GitHub file size limits.

SQLite is the browser runtime database.

SpeciedexTerminal searches SQLite only.

------------------------------------------------------------------------------

## build-mariadb-shards.py

Generates compressed MariaDB-compatible logical exports.

Responsibilities include

- schema generation
- INSERT streams
- compression
- checksums
- manifests

MariaDB is intended for

- production deployments
- replication
- backups
- analytics
- server-side services

The browser never connects directly to MariaDB.

------------------------------------------------------------------------------

## build-db-indexes.py

Builds lightweight browser lookup indexes.

Examples include

- scientific names
- common names
- provider indexes
- rank indexes
- lineage indexes
- shard routing tables
- autocomplete indexes

The terminal consults these indexes before loading SQLite shards.

------------------------------------------------------------------------------

## build-db-manifests.py

Produces

- manifest.json
- providers.json
- schema.json
- build-state.json
- checksums.json

These describe the published database state.

------------------------------------------------------------------------------

## verify-shards.py

Verifies

- shard sizes
- SQLite integrity
- gzip archives
- hashes
- manifests
- row counts
- routing indexes

Publication fails if any verification fails.

------------------------------------------------------------------------------

## verify-database-parity.py

Ensures SQLite and MariaDB remain identical.

Checks include

- total records
- taxonomy identifiers
- provider counts
- lineage
- hashes
- update timestamps

Neither format is allowed to drift.

------------------------------------------------------------------------------

## import-sqlite.py

Imports SQLite data back into canonical JSONL.

Does not publish database changes directly.

------------------------------------------------------------------------------

## import-mariadb.py

Imports MariaDB exports into canonical JSONL.

Does not overwrite SQLite.

------------------------------------------------------------------------------

## reconcile-databases.py

Resolves imported records against canonical taxonomy.

Handles

- duplicates
- lineage conflicts
- provider conflicts
- authority conflicts
- synonym resolution

Only after reconciliation are new database builds permitted.

------------------------------------------------------------------------------

## common.py

Shared helper library.

Provides

- normalization
- hashing
- schema validation
- shard calculations
- atomic writes
- manifests
- logging
- integrity helpers

All database tools should use this shared library rather than duplicating
functionality.

------------------------------------------------------------------------------

# Build Commands

Complete rebuild

```bash
python static/tools/database/build-databases.py
```

Incremental update

```bash
python static/tools/database/update-databases.py
```

Verify database integrity

```bash
python static/tools/database/verify-shards.py
```

Verify SQLite/MariaDB parity

```bash
python static/tools/database/verify-database-parity.py
```

------------------------------------------------------------------------------

# Browser Database Architecture

The browser never opens MariaDB directly.

Instead

```text
Terminal
      │
      ▼
manifest.json
      │
      ▼
browser indexes
      │
      ▼
SQLite shard routing
      │
      ▼
SQLite workers
      │
      ▼
merged search results
```

MariaDB remains a deployment, archival, replication, and analytics format.

------------------------------------------------------------------------------

# Database Rules

The following rules always apply.

- `static/data/taxonomy/` is the only canonical source.
- SQLite and MariaDB are generated products.
- SQLite and MariaDB must always contain identical canonical records.
- Database imports never overwrite the opposite format directly.
- Imported changes must pass through taxonomy reconciliation.
- Browser search uses SQLite only.
- MariaDB is server-side only.
- Shards must remain below repository publication limits.
- Every published build requires successful verification.
- Credentials must never be embedded in source code or generated products.

------------------------------------------------------------------------------

# Future Expansion

Planned additions include

- delta shard generation
- binary diff updates
- automatic shard balancing
- SQLite full-text indexes
- vector indexes
- Bloom filters
- compressed browser search indexes
- database version history
- rollback snapshots
- signed releases
- distributed mirror synchronization
