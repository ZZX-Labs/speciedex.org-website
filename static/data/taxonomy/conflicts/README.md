# Unresolved Taxonomy Conflicts

This directory contains provider disagreements that could not be resolved automatically by normalization and policy rules.

## Current file

- `unresolved.jsonl` — appendable set of unresolved conflict records.

## Conflict record expectations

```json
{
  "conflict_id": "conflict:...",
  "speciedex_id": "spx:...",
  "field": "accepted_name",
  "assertions": [
    {"provider": "provider-a", "value": "...", "confidence": 0.9},
    {"provider": "provider-b", "value": "...", "confidence": 0.8}
  ],
  "priority": "high",
  "status": "unresolved",
  "detected_at": "2026-07-24T12:00:00Z"
}
```

## Rules

- Preserve every competing assertion and its provider provenance.
- Do not silently select a winner when policy confidence is insufficient.
- Resolution must produce a revision record and retain the original conflict history.
- Resolved conflicts should move to an archived/resolved stream rather than being erased.
- High-priority identity, accepted-name, rank, and synonym conflicts must be surfaced in reports and terminal commands.

## Consumers

- conflict policy tools;
- provider assertion tools;
- revision generation;
- `terminal-unresolved-conflicts.js`;
- release and integrity reports.

Unresolved conflicts should not prevent the entire database build unless they violate a required identity or schema invariant. Their status must remain visible in manifests and diagnostics.
