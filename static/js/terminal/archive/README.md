# SpeciedexTerminal Archive Modules

This directory contains the terminal modules that expose immutable archive metadata, release history, checksums, volumes, source assertions, synonym records, and unresolved reconciliation conflicts.

These modules are read-only terminal clients. They do not write archive files or alter canonical taxonomy. Every module registers itself in `window.SpeciedexTerminalModules`, exposes a named browser global, registers one service with the shared terminal context, and contributes commands to the terminal command registry.

## Files and commands

| File | Service | Primary commands |
|---|---|---|
| `terminal-archive-history.js` | `archive-history` | `archive-history`, `archive-history-latest`, `archive-history-status` |
| `terminal-checksums.js` | `checksums` | `checksums`, `checksum`, `checksum-verify`, `checksums-status` |
| `terminal-last-updated.js` | `last-updated` | `last-updated`, `last-updated-latest`, `last-updated-stale`, `last-updated-status` |
| `terminal-manifests.js` | `manifests` | `manifests`, `manifest`, `manifest-compare`, `manifests-latest`, `manifests-status` |
| `terminal-records-archived.js` | `records-archived` | `records-archived`, `records-archived-totals`, `records-archived-status` |
| `terminal-releases.js` | `releases` | `releases`, `release`, `release-latest`, `release-stable`, `releases-status` |
| `terminal-source-assertions.js` | `source-assertions` | `source-assertions`, `source-assertions-summary`, `source-assertion-conflicts`, `source-assertions-status` |
| `terminal-synonyms.js` | `synonyms` | `synonyms`, `synonym-resolve`, `synonym-ambiguities`, `synonyms-summary`, `synonyms-status` |
| `terminal-unresolved-conflicts.js` | `unresolved-conflicts` | `unresolved-conflicts`, `conflict`, `conflicts-high-priority`, `conflicts-summary`, `unresolved-conflicts-status` |
| `terminal-volumes.js` | `volumes` | `volumes`, `volume`, `volume-latest`, `volumes-summary`, `volumes-status` |

## Runtime contract

Each module expects a terminal context containing the shared API client and service registry. The common pattern is:

```javascript
const service = context.services.get("archive-history");
const result = await service.list({ limit: 50 });
```

The loader must initialize `terminal-api.js` and the terminal service registry before archive commands execute. Failures from one optional archive endpoint must be reported through the terminal without preventing unrelated modules from loading.

## Data sources

Archive modules consume the published archive/database metadata exposed by the Speciedex data layer. Expected sources include:

- `static/data/db/manifest.json`
- `static/data/db/checksums.json`
- `static/data/db/build-state.json`
- `static/data/db/sqlite/manifest.json`
- `static/data/db/mariadb/manifest.json`
- `static/data/db/updates/manifest.json`
- archive release and volume endpoints provided by the shared API/data broker

The browser terminal must not modify these files. Changes originate in `static/data/taxonomy/` and are published by the Python database/archive toolchain.

## Validation requirements

Before release:

```bash
node --check static/js/terminal/archive/*.js
python static/tools/database/verify-shards.py
python static/tools/database/verify-database-parity.py
```

The archive command names listed above must also be present in `static/js/terminal/manifest.json` or discovered dynamically by the terminal loader.
