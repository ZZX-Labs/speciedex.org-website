# Speciedex Taxonomy Data Pipeline

This directory is the canonical filesystem store for taxonomy collected from
the configured provider set. Database shards, indexes, statistics, icons,
reports, and terminal search data are derived from it.

## Stages

- `raw/`: immutable provider payloads and source archives.
- `normalized/`: canonicalized records after field mapping and validation.
- `rejected/`: invalid or unprocessable records with diagnostics.
- `provider-state/`: provider cursors, timestamps, hashes, and ingestion state.
- `revisions/`: append-only canonical record revisions.
- `conflicts/`: unresolved reconciliation conflicts and evidence.
- `volumes/`: bounded archival output volumes.
- `manifest.json`: taxonomy catalog and aggregate counts.
- `scheduler.json`: provider scheduling and update cadence.

```text
77 providers -> raw -> normalize/validate -> deduplicate/reconcile
             -> canonical records -> revisions/conflicts/volumes
             -> SQLite + MariaDB -> indexes/statistics/icons/terminal
```

Normalized and reconciled records are the source used to rebuild both database
formats. Direct database changes must be imported, reconciled here, and then
regenerated uniformly.

Canonical records should retain stable Speciedex identity, names, rank, status,
lineage, provider assertions, timestamps, licensing, and deterministic hashes.
Before publication, schemas, conflicts, manifests, statistics, database parity,
checksums, and incremental additions must all be updated.
