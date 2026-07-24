# Rejected Taxonomy Records

This directory contains provider records that could not enter the canonical normalized dataset. Rejection is explicit and auditable; records must not be silently discarded.

## Current file

- `invalid-records.jsonl` — one rejection object per line.

## Recommended rejection shape

```json
{
  "provider": "provider-name",
  "source_file": "raw/provider/batch.jsonl",
  "source_index": 42,
  "reason": "missing scientific name",
  "code": "missing_required_field",
  "record": {},
  "rejected_at": "2026-07-24T12:00:00Z"
}
```

## Rules

- Preserve the original record or a lossless reference to it.
- Include a machine-readable rejection code and human-readable reason.
- Include provider, source file, and source record position whenever known.
- Do not include credentials or private request metadata.
- A corrected record should re-enter through raw/normalized processing; do not edit the normalized dataset by hand.
- Rejection counts must be included in provider reports and build diagnostics.

## Consumers

Provider tests, daily/weekly/monthly reports, normalization diagnostics, and terminal provider-error commands may summarize this directory. Rejected records are never written to published SQLite or MariaDB taxonomy shards unless explicitly retained in a separate diagnostics table.
