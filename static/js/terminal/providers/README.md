# SpeciedexTerminal Provider Modules

This directory contains terminal services and commands for the 77 configured taxonomic providers. The modules expose provider configuration, eligibility, enablement, documentation, assertions, errors, latency, overlap, statistics, and provider-specific species records.

Provider modules are read-only browser clients. Provider collection, authentication, normalization, reconciliation, and publication are performed by the Python tools under `static/tools/`.

## Files and commands

| File | Service | Primary commands |
|---|---|---|
| `terminal-providers.js` | `providers` | `providers`, `provider`, `providers-available`, `providers-summary`, `providers-status` |
| `terminal-eligible-providers.js` | `eligible-providers` | `eligible-providers`, `eligible-provider`, `ingestion-ready-providers`, `eligible-providers-summary`, `eligible-providers-status` |
| `terminal-enabled-providers.js` | `enabled-providers` | `enabled-providers`, `enabled-provider`, `available-enabled-providers`, `healthy-enabled-providers`, `enabled-providers-summary`, `enabled-providers-status` |
| `terminal-provider-assertions.js` | `provider-assertions` | assertion listing, conflict filtering, low-confidence filtering, summary, status |
| `terminal-provider-documentation.js` | `provider-documentation` | document lookup, current/deprecated/missing filters, summary, status |
| `terminal-provider-errors.js` | `provider-errors` | active/retryable/fatal/validation error views, summary, status |
| `terminal-provider-latency.js` | `provider-latency` | measurement lookup, slow/degraded/timeout views, summary, status |
| `terminal-provider-overlap.js` | `provider-overlap` | pair comparison, high/low overlap, duplicates, asymmetry, matrix, summary, status |
| `terminal-provider-species.js` | `provider-species` | species lookup, accepted/extinct/threatened/endemic filters, summary, status |
| `terminal-provider-statistics.js` | `provider-statistics` | provider statistics, top/bottom, healthy/degraded, trends, summary, status |

## Runtime contract

Each module requires:

- `context.api.get(...)` or the future database-backed data broker;
- `context.registerService(name, service)`;
- `context.services.get(name)`;
- terminal command output helpers such as `writeJSON` and `writeError`;
- optional `context.events` propagation.

All module initialization must be idempotent. A previously registered live service should be reused rather than duplicated.

## Provider data flow

```text
static/tools/providers/ and provider-specific tools
        ↓
static/data/taxonomy/raw/
        ↓
normalization, rejection, conflict handling, revisions
        ↓
static/data/taxonomy/normalized/ and volumes/
        ↓
SQLite and MariaDB shards in static/data/db/
        ↓
static/js/data.js and terminal workers
        ↓
provider commands in this directory
```

The terminal should search published database products rather than provider APIs directly. Direct provider calls belong in the ingestion tools, not the public browser terminal.

## Security

No credentials, usernames, access tokens, private API keys, or secrets may be embedded in these files. Provider authentication belongs in server-side/local Python tooling and CI secrets.

## Validation requirements

```bash
node --check static/js/terminal/providers/*.js
python static/tools/database/verify-shards.py
python static/tools/database/verify-database-parity.py
```

The provider totals in the terminal must agree with `static/tools/providers.json`, `static/data/db/providers.json`, and the provider-state files under `static/data/taxonomy/provider-state/`.
