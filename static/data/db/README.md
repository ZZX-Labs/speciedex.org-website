# Speciedex Database Products

This directory contains the generated database layer derived from
`static/data/taxonomy/`. Taxonomy remains the canonical source of truth;
SQLite shards, MariaDB logical exports, browser indexes, update streams,
manifests, checksums, and verification reports are derived products.

## Contents

- `manifest.json`: top-level database catalog used by browser and terminal data
  services.
- `schema.json`: shared canonical record model.
- `checksums.json`: SHA-256 hashes and byte sizes for published products.
- `build-state.json`: build completion state and aggregate totals.
- `providers.json`: provider coverage and expected 77-provider inventory.
- `sqlite/`: browser-queryable SQLite shards and shard manifest.
- `mariadb/`: compressed MariaDB-compatible logical shards, schema, and
  manifest.
- `indexes/`: lightweight name, taxonomy, provider, and shard-routing indexes.
- `updates/`: incremental additions, changes, and deletions.
- `reports/`: integrity and SQLite/MariaDB parity reports.

Build everything from the repository root:

```bash
python static/tools/database/build-databases.py
```

SQLite and MariaDB must always be generated from the same canonical record
stream. Do not edit and publish one format independently. Import a database
change back into taxonomy JSONL, reconcile it, and rebuild both formats.

The browser terminal reads `manifest.json`, uses the indexes to select shards,
loads SQLite through a worker, and merges cross-shard results. It does not
connect directly to MariaDB. MariaDB exports are for deployment, replication,
backup, and parity verification.

Shard builders target 72 MiB and enforce a 90 MiB ceiling. Publication requires
matching row counts, valid checksums, SQLite integrity, valid gzip exports,
valid index references, and `build-state.json` reporting a complete build.
