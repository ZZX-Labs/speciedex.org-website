# Taxonomy Revisions

This directory contains append-only revision records describing canonical taxonomy changes over time.

## Current file

- `revisions-000001.jsonl` — first revision segment.

## Revision model

A revision should identify the affected record, the operation, old/new hashes, provenance, and time:

```json
{
  "revision_id": "rev:...",
  "speciedex_id": "spx:...",
  "operation": "update",
  "before_hash": "...",
  "after_hash": "...",
  "provider": "provider-name",
  "reason": "accepted-name change",
  "changed_at": "2026-07-24T12:00:00Z"
}
```

Supported operations should be explicit, such as `insert`, `update`, `merge`, `split`, `deprecate`, `restore`, or `delete`.

## Rules

- Revision segments are append-only after publication.
- Published revisions are never rewritten to disguise history.
- Each change must be reproducible from source assertions and normalization policies.
- Segments must stay below repository file-size limits.
- The update stream in `static/data/db/updates/` is generated from canonical changes; revisions remain the authoritative audit trail.

## Consumers

Archive history commands, release generation, update feeds, conflict resolution, reports, and database rebuild verification use these files.
