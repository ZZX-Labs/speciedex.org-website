# Provider State

This directory stores resumable ingestion state for each taxonomy provider. State files allow scheduled tools to continue incremental downloads without re-fetching the entire provider dataset.

## Current files

- `darwin_core_archive.json`
- `gbif.json`
- `inaturalist.json`
- `itis.json`
- `wikipedia.json`
- `wikispecies.json`
- `worms.json`

Additional provider state files should use the same normalized provider identifier as `static/tools/providers.json`.

## State responsibilities

A provider state document may contain:

- last successful run time;
- next cursor, page, offset, or continuation token;
- last source update time or ETag;
- completed volumes or batches;
- retry/error counters;
- record totals;
- schema/tool version;
- last output paths and hashes.

## Security rule

Provider state files are public repository data. They must never contain API keys, bearer tokens, passwords, private cookies, signed URLs, or other credentials. Authentication values belong in environment variables or GitHub Actions secrets and must be injected only at runtime.

## Consistency

State is updated only after output files are written and verified. Failed runs must not advance the persisted cursor. Changes should be atomic to avoid corrupting scheduled ingestion.

## Consumers

- provider fetch/update tools;
- `static/tools/stat-grabber.py`;
- scheduled GitHub workflows;
- provider health/status reports;
- database update orchestration.
