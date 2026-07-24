# Speciedex Core Pipeline Library

This directory contains provider-neutral Python components used by collection,
normalization, reconciliation, archives, statistics, and database generation.

Modules cover archives, authorities, caches, conflicts, database backends and
management, deduplication, hashing, health, history, lineage, manifests,
MariaDB and SQLite indexing, metrics, provider coordination, reconciliation,
revision writing, scheduling, statistics, synonym indexing, taxonomy,
validation, and bounded volume writing.

Provider-specific transport and field mapping belong in
`static/tools/providers/`. Configuration belongs in schemas and policies.
Core writes should be deterministic and atomic; invalid records must be rejected
or recorded as conflicts rather than silently discarded. Database changes flow
through canonical taxonomy and regenerate SQLite and MariaDB together.

These modules must not contain or print public credentials.
