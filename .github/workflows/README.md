# Speciedex GitHub Actions Workflows

This directory contains the automation responsible for refreshing the
Speciedex taxonomic archive, rebuilding deterministic taxonomic icons,
generating public database products, and exposing refresh status to the public
terminal.

The coordinated workflow chain is:

```text
terminal-update.yml
        |
        v
update-database.yml
        |
        +--> update-statistics.yml
        |        |
        |        +--> validate all 77 registered providers
        |        +--> classify executable and blocked providers
        |        +--> run one registry-wide --all-providers scan
        |        +--> rebuild archive statistics and manifests
        |
        +--> update-icons.yml
        |        |
        |        +--> validate canonical taxonomy volumes
        |        +--> normalize and expand lineage taxa
        |        +--> quarantine bounded malformed records
        |        +--> build master icons, derivatives, and sprites
        |
        +--> build SQLite, MariaDB, and browser-index products
        |
        +--> publish static/data/terminal-update-status.json
```

The canonical taxonomy under `static/data/taxonomy/` is authoritative.
SQLite, MariaDB, icon indexes, browser indexes, manifests, checksums,
statistics, reports, and terminal status files are generated products.

## Workflow inventory

| Workflow | Purpose | Direct triggers | Reusable |
|---|---|---|---|
| [`terminal-update.yml`](terminal-update.yml) | Accept and validate a public full-refresh request | `repository_dispatch`, manual dispatch | No |
| [`update-database.yml`](update-database.yml) | Orchestrate statistics, icons, databases, and final status | Manual dispatch | Yes |
| [`update-statistics.yml`](update-statistics.yml) | Run the registry-wide provider pass and rebuild the archive | Manual dispatch, every five minutes | Yes |
| [`update-icons.yml`](update-icons.yml) | Build and publish deterministic taxonomic glyph products | Manual dispatch, weekly schedule, taxonomy/tool pushes | Yes |

All scheduled times use UTC.

## Core execution contract

The provider registry contains exactly 77 registered providers.

A registry-wide pass means:

1. all 77 registry definitions are validated;
2. all 77 providers are classified as executable or blocked;
3. no individual provider selector is accepted;
4. `stat-grabber.py scan --all-providers` is invoked exactly once; and
5. every blocked provider and reason is included in the workflow summary.

It does **not** mean that all 77 providers can always execute. A registered
provider may be blocked by a missing import dataset, missing optional
credential, disabled configuration, dependency failure, rate limit, cooldown,
or provider-health state.

The accounting invariant is:

```text
registered providers = executable providers + blocked providers = 77
```

A run may proceed when at least one provider is executable. A run must fail
when registry accounting does not total 77 or when zero providers can execute.

The status record distinguishes these values:

```json
{
  "provider_count_expected": 77,
  "provider_count_actual": 77,
  "provider_count_executable": 7,
  "provider_count_blocked": 70,
  "execution_model": "registry_wide_all_providers",
  "single_pass": true
}
```

The executable and blocked counts are examples and vary with repository data,
credentials, and provider state.

---

# `terminal-update.yml`

`terminal-update.yml` is the public entry point for a complete refresh. It
accepts only an all-provider request, writes an immediate queued status record,
and invokes `update-database.yml`.

## Triggers

### Repository dispatch

Event type:

```text
speciedex-terminal-full-update
```

Accepted `client_payload` fields:

| Field | Required | Description |
|---|---:|---|
| `scope` | Yes | Must be exactly `all_providers` |
| `request_id` | No | Audit identifier, maximum 96 characters |
| `requested_by` | No | Sanitized requester label |

No provider-selection fields are accepted. Unknown payload fields cause the
request to fail validation.

Example payload:

```json
{
  "event_type": "speciedex-terminal-full-update",
  "client_payload": {
    "scope": "all_providers",
    "request_id": "terminal-20260725-001",
    "requested_by": "public-terminal"
  }
}
```

A public browser must not contain a repository token. Route public requests
through a trusted server-side relay, GitHub App, or other authenticated backend.

### Manual dispatch

Manual dispatch accepts an optional `request_id` and is intended for testing
the terminal execution path.

## Request validation

The workflow:

- requires `scope=all_providers` for repository-dispatch requests;
- rejects unknown payload fields;
- rejects provider-specific selection;
- limits request identifiers to 96 characters;
- allows only `A-Z`, `a-z`, digits, `.`, `_`, `:`, `@`, `/`, and `-`;
- sanitizes the requester label; and
- writes request metadata to the job summary.

## Queued status

Before the database refresh begins, the workflow writes:

```text
static/data/terminal-update-status.json
```

The queued record includes:

- request ID and origin;
- requester label;
- request timestamp;
- expected provider count;
- component states;
- GitHub run metadata;
- run URL; and
- `status: queued`.

The queued status is committed by:

```text
speciedex-terminal-bot
speciedex-terminal-bot@users.noreply.github.com
```

## Reusable call

The workflow invokes `update-database.yml` with:

```yaml
with:
  request_id: <validated request ID>
  request_origin: terminal
  requested_by: <validated requester>
secrets: inherit
```

---

# `update-database.yml`

`update-database.yml` coordinates the complete public refresh.

## Inputs

| Input | Type | Default | Description |
|---|---|---|---|
| `request_id` | string | empty | Audit and public-status identifier |
| `request_origin` | string | `manual` or `workflow` | Origin of the refresh |
| `requested_by` | string | empty | Requester recorded in final public status |

Manual origin choices are:

```text
manual
terminal
scheduled
maintenance
```

## Outputs

| Output | Description |
|---|---|
| `request_id` | Normalized request identifier |
| `status` | Final public refresh status |

## Job sequence

### 1. Update statistics

The reusable statistics workflow receives:

```yaml
target_ref: main
request_id: <propagated request ID>
request_origin: <propagated origin>
orchestrated: true
```

`orchestrated: true` prevents the taxonomy-bot commit from triggering an
unnecessary second icon build while `update-database.yml` is already calling
the icon workflow explicitly.

### 2. Update icons

The icon workflow starts after statistics completes. The default coordinated
build uses:

```yaml
force_rebuild: false
icon_size: "1024"
target_ref: main
```

### 3. Build database products

The database job checks out the newly committed taxonomy and icon products,
then runs:

```bash
python static/tools/database/update-databases.py \
  --taxonomy-root static/data/taxonomy \
  --db-root static/data/db \
  --clean \
  --verify \
  --publish \
  --strict-records \
  --verbose
```

The database pipeline is expected to build and verify:

```text
static/data/db/
├── sqlite/
├── mariadb/
├── indexes/
├── reports/
├── manifest.json
├── checksums.json
└── build-state.json
```

Required public browser products are:

```text
static/data/db/indexes/species.json
static/data/db/indexes/names.json
static/data/db/indexes/providers.json
static/data/db/indexes/taxonomy.json
static/data/db/indexes/manifest.json
static/data/db/manifest.json
static/data/db/checksums.json
static/data/db/build-state.json
```

`static/data/db/indexes/shards.json` is optional unless the index builder is
explicitly run in shard mode.

The database updater must publish atomically. Staging products belong under a
temporary database tree and must not replace the public tree until all
verification steps pass.

### 4. Publish terminal-visible status

The final status job always runs, even when another component fails.

It records component results for:

```text
statistics
icons
database
```

The overall result is `success` only when all three component results are
`success`. Otherwise, it is `failed`.

The final status is committed to:

```text
static/data/terminal-update-status.json
```

## Concurrency

The full database workflow uses one global concurrency group:

```text
speciedex-full-database-refresh
```

`cancel-in-progress` is disabled. A complete refresh is never intentionally
cancelled by a newer request.

---

# `update-statistics.yml`

`update-statistics.yml` validates the 77-provider registry, loads optional
credentials, classifies provider availability, executes one registry-wide scan,
rebuilds statistics, verifies the archive, and publishes changed products.

## Triggers

| Trigger | Behavior |
|---|---|
| Manual dispatch | Run a complete registry-wide pass |
| Reusable call | Run as part of another workflow |
| Schedule | `*/5 * * * *`, every five minutes |

The five-minute schedule is intentionally aggressive. Concurrency prevents
overlapping runs for the same target branch, but repository owners should
review Actions usage and provider rate limits regularly.

## Inputs

| Input | Type | Default | Description |
|---|---|---|---|
| `request_id` | string | empty | Audit identifier |
| `request_origin` | string | `manual` or `workflow` | Invocation origin |
| `target_ref` | string | `main` | Branch receiving archive products |
| `orchestrated` | boolean | `false` | Marks calls from `update-database.yml` |

## Outputs

| Output | Description |
|---|---|
| `request_id` | Normalized request identifier |
| `provider_count` | Registered and validated provider count |
| `eligible_count` | Providers executable during the current pass |
| `skipped_count` | Providers blocked by runtime prerequisites |
| `archive_changed` | Whether generated archive data changed |

## Provider validation

Before the scan, the workflow verifies:

- `static/tools/providers.json` is valid JSON;
- the registry contains exactly 77 unique enabled definitions;
- every provider name uses the canonical lowercase underscore format;
- every declared provider module exists and imports;
- every module exposes the required provider class;
- provider names agree between the registry and module;
- every provider exposes a fetch implementation; and
- the canonical inventory contains no missing or unexpected provider.

A registry-count mismatch is a configuration failure. Do not change the
expected count merely to make a run pass.

## Provider availability

Each validated provider is classified as executable or blocked.

Common blocked reasons include:

```text
missing dataset: static/data/import/<provider>.jsonl
missing environment: <SECRET_NAME>
disabled
cooldown
dependency unavailable
provider health state
```

Blocked providers remain part of the 77-provider accounting contract. They are
reported in a Markdown table in the GitHub job summary.

## Optional credentials

The workflow recognizes these repository secrets:

| Secret | Provider or purpose |
|---|---|
| `EOL_API_KEY` | Encyclopedia of Life |
| `IUCN_API_TOKEN` | IUCN Red List and Green products |
| `NATURESERVE_API_KEY` | NatureServe |
| `NCBI_API_KEY` | NCBI request-rate enhancement |
| `BACDIVE_USERNAME` | BacDive |
| `BACDIVE_PASSWORD` | BacDive |
| `BHL_API_KEY` | Biodiversity Heritage Library |
| `GEONAMES_USERNAME` | GeoNames |
| `YOUTUBE_API_KEY` | YouTube |
| `GOOGLE_API_KEY` | Google API fallback or related integration |

These credentials are optional to the workflow as a whole. A provider that
requires a missing credential is classified as blocked.

Never commit credentials into:

```text
static/tools/providers.json
static/tools/providers/
.github/workflows/
static/data/
```

## Registry-wide scan

The workflow executes one command:

```bash
python static/tools/stat-grabber.py \
  scan \
  --all-providers \
  --batch-size 5000 \
  --timeout 40 \
  --retries 5 \
  --backoff 2 \
  --volume-target-mb 48 \
  --volume-max-mb 90 \
  --history-limit 1008 \
  --verbose
```

Do not add `--provider`, `--providers`, or another provider selector to this
workflow.

## Archive products

The scan and post-processing stages maintain products including:

```text
static/data/statistics.json
static/data/statistics-sources.json
static/data/statistics-history.json
static/data/taxonomy/manifest.json
static/data/taxonomy/scheduler.json
static/data/taxonomy/provider-state/
static/data/taxonomy/volumes/
```

The derived taxonomy SQLite index may be cached between runs but is removed
before publication when it is not intended as a committed artifact.

The archive commit is authored by:

```text
speciedex-taxonomy-bot
speciedex-taxonomy-bot@users.noreply.github.com
```

A commit produced during a coordinated database refresh records:

```text
Orchestrated: true
```

A standalone scheduled scan records:

```text
Orchestrated: false
```

This marker is consumed by the icon workflow's push-trigger guard.

## Concurrency

The concurrency group is branch-specific:

```text
speciedex-taxonomy-update-<target-ref>
```

A terminal-origin request may cancel an older in-progress taxonomy update for
the same branch.

---

# `update-icons.yml`

`update-icons.yml` converts the canonical taxonomy archive into deterministic
master icons, resized derivatives, a sprite sheet, manifests, reports, and
checksums.

## Triggers

| Trigger | Behavior |
|---|---|
| Manual dispatch | Build icons with selectable size and rebuild mode |
| Reusable call | Build as part of the database workflow |
| Schedule | Mondays at `04:17` UTC |
| Push | Rebuild when taxonomy, icon tools, or related configuration changes |

Relevant push paths include:

```text
static/data/taxonomy/**
static/config/**
static/tools/icon-forge.py
static/tools/icon-forge/**
requirements.txt
pyproject.toml
.github/workflows/update-icons.yml
```

## Inputs

| Input | Type | Default | Description |
|---|---|---|---|
| `force_rebuild` | boolean | `false` | Remove generated icons and rebuild all queued taxa |
| `icon_size` | string | `"1024"` | Master icon size: 512, 1024, or 2048 |
| `request_id` | string | empty | Audit identifier |
| `request_origin` | string | `manual` or `workflow` | Invocation origin |
| `target_ref` | string | `main` | Branch receiving generated assets |
| `max_rejected_percent` | number | `1.0` | Maximum quarantined source-record percentage |
| `max_rejected_records` | number | `1000` | Maximum quarantined source-record count |

Both rejection ceilings must be satisfied.

## Outputs

| Output | Description |
|---|---|
| `request_id` | Normalized request identifier |
| `icon_count` | Total indexed taxa |
| `assets_changed` | Whether generated assets changed |

## Push-loop protection

The icon job skips push-triggered runs when:

1. the commit was authored by `speciedex-icon-bot`; or
2. the commit was authored by `speciedex-taxonomy-bot` and contains
   `Orchestrated: true`.

This prevents icon commits from triggering themselves and prevents duplicate
icon builds during a coordinated database refresh.

A standalone scheduled taxonomy update may still trigger the icon workflow.

## Required tools

The workflow validates and compiles:

```text
static/tools/icon-forge.py
static/tools/icon-forge/normalize-taxonomy.py
static/tools/icon-forge/enrich-taxonomy.py
static/tools/icon-forge/icon-index.py
static/tools/icon-forge/build-icons.py
static/tools/icon-forge/build-icon-derivatives.py
static/tools/icon-forge/build-sprites.py
static/tools/icon-forge/verify-icons.py
```

There is no required `FETCHER` variable in the canonical-volume workflow.
Reintroducing an undefined `$FETCHER` reference under `set -u` will terminate
the job immediately.

## Canonical taxonomy validation

The workflow reads:

```text
static/data/taxonomy/manifest.json
static/data/taxonomy/volumes/
```

It verifies that:

- the manifest exists and is valid JSON;
- the manifest declares at least one volume;
- every declared volume exists;
- every observed volume count matches its declared count; and
- the sum of observed records equals `total_primary_records`.

## Taxonomy normalization

The normalizer writes:

```text
static/data/taxonomy/normalized/all-taxa.jsonl
static/data/taxonomy/rejected/invalid-records.jsonl
static/data/icons/normalization-report.json
```

The canonical-aware normalizer:

- accepts canonical `speciedex_id` fields;
- reads nested taxonomy mappings;
- reads `initial_source` metadata;
- expands every lineage node into its own taxon;
- creates deterministic IDs for intermediate taxa;
- preserves terminal canonical identifiers;
- deduplicates shared lineage taxa globally; and
- quarantines malformed records.

Because lineage nodes are expanded and shared taxa are deduplicated, this is
not a valid invariant:

```text
normalized unique taxa == source archive records
```

The valid normalization checks are:

```text
normalizer source_records == archive manifest records
normalized JSONL lines == report unique_taxa
expanded_candidates >= unique_taxa
rejected JSONL lines == report rejected_records
unique_taxa > 0
```

## Rejection quarantine

Malformed records are preserved in the rejected JSONL file and may be tolerated
within configured bounds.

Default limits:

```text
maximum rejected records: 1,000
maximum rejected percent: 1.0%
```

The workflow fails when either limit is exceeded.

For example:

```text
source records: 67,901
rejected: 581
rejected percentage: 0.855658%
```

This example is below both default limits, so the workflow continues while
emitting a warning and retaining the rejected records for repair.

A growing rejection count should be investigated even when the build remains
under the threshold.

## Icon-generation stages

After normalization, the workflow:

1. enriches stable traits;
2. initializes the derived icon SQLite schema;
3. imports normalized taxa;
4. optionally resets all icon state;
5. exports the pending, stale, and failed icon queue;
6. verifies queued identities;
7. renders master icons;
8. updates icon state from the generated manifest;
9. builds 512, 256, 128, 64, and 32-pixel derivatives;
10. generates the 64-pixel sprite sheet;
11. verifies generated assets;
12. writes the generation report;
13. removes the derived icon SQLite index;
14. writes SHA-256 checksums;
15. uploads a build artifact; and
16. commits changed products.

## Icon products

Primary outputs include:

```text
static/images/taxa/master/
static/images/taxa/512/
static/images/taxa/256/
static/images/taxa/128/
static/images/taxa/64/
static/images/taxa/32/
static/images/taxa/sprites/taxa-64.png
static/data/icons/icon-manifest.json
static/data/icons/generation-report.json
static/data/icons/normalization-report.json
static/data/icons/sprite-index.json
static/data/icons/SHA256SUMS
```

The derived icon SQLite database is a build-time artifact and is removed before
the generated assets are committed.

The icon commit is authored by:

```text
speciedex-icon-bot
speciedex-icon-bot@users.noreply.github.com
```

## Concurrency

The concurrency group is branch-specific:

```text
speciedex-icon-update-<target-ref>
```

A terminal-origin icon request may cancel an older in-progress icon update for
the same branch.

---

# Repository permissions and settings

These workflows require repository Actions settings that allow the generated
`GITHUB_TOKEN` to write repository contents.

Recommended repository setting:

```text
Settings
  -> Actions
  -> General
  -> Workflow permissions
  -> Read and write permissions
```

Branch protection must permit the workflow bots to publish generated products,
or an approved pull-request publication model must replace direct pushes.

The workflows use `contents: write`. The database orchestrator also requests
`actions: read`.

## GitHub Actions runtime warnings

Warnings that an action targets an older Node.js runtime are not, by
themselves, workflow failures. A workflow fails only when a step or action
returns a failing result.

Action versions should be upgraded deliberately after confirming that the
replacement release exists and preserves the required inputs and behavior.
Do not change action version tags merely to suppress a warning without
validation.

---

# Generated commits

The automation uses these authors:

| Bot | Products |
|---|---|
| `speciedex-taxonomy-bot` | Taxonomy archive and statistics |
| `speciedex-icon-bot` | Taxonomic icons, reports, sprites, checksums |
| `speciedex-database-bot` | SQLite, MariaDB, and browser database products |
| `speciedex-terminal-bot` | Queued and final terminal status records |

Generated commit messages include request IDs, origins, workflow run IDs, and
the orchestration marker where appropriate.

Every publishing step:

1. stages only its owned generated paths;
2. exits successfully when there is no diff;
3. commits the changed products;
4. pulls with rebase;
5. retries publication up to three times; and
6. aborts a failed rebase before retrying.

---

# Failure diagnostics

## Invalid reusable-workflow input

Example:

```text
Invalid input, all_providers is not defined in the referenced workflow
```

Cause:

A caller passes a `with:` key that the callee does not declare under
`workflow_call.inputs`.

Correction:

Remove the unsupported caller input or explicitly add a matching callee input.
`update-statistics.yml` does not need an `all_providers` input because its scan
command is already permanently registry-wide.

## Provider registry count mismatch

Example:

```text
Provider registry count mismatch: expected 77, found 76
```

Cause:

A provider definition is absent, duplicated, disabled, malformed, or fails the
module-coverage contract.

Correction:

Repair `static/tools/providers.json` or the corresponding provider module.
Do not lower the expected count.

## Provider accounting mismatch

Example:

```text
expected 77 registered providers to be classified
```

Cause:

The executable and blocked classifications do not account for all validated
providers.

Correction:

Inspect the provider manager's availability report and classification logic.
The correct invariant is:

```text
executable + blocked = 77
```

## Many providers reported as blocked

Example:

```text
Executable now: 7
Blocked or unavailable: 70
```

This is informational when accounting still totals 77 and at least one provider
can execute.

Repair missing prerequisites by:

- placing required import datasets under `static/data/import/`;
- configuring repository secrets;
- replacing file-backed placeholders with functioning live adapters;
- restoring missing dependencies; or
- clearing legitimate provider cooldown or health conditions.

## `FETCHER: unbound variable`

Cause:

A shell step running with `set -u` references `$FETCHER`, but no job or step
environment variable defines it.

Correction:

Remove the stale `$FETCHER` compile target. The canonical-volume icon workflow
does not use a bootstrap fetcher.

## Normalizer exits after producing valid taxa

Example:

```text
source_records=67901
unique_taxa=76498
rejected=581
Process completed with exit code 1
```

Cause:

Absolute strict mode treats every rejected source record as fatal.

Correction:

Use bounded rejection quarantine. Validate both the rejection count and
percentage, preserve the rejected file, and continue when both limits pass.

## Normalized count differs from archive count

This is expected because the normalizer expands lineage nodes and deduplicates
shared taxa.

Do not compare:

```text
unique_taxa == source_records
```

Compare the normalization report against the source manifest and output files
using the checks documented above.

## Missing SQLite shard ending in `.tmp`

Example:

```text
Missing sqlite shard: speciedex-000001.sqlite3.tmp
```

Cause:

The SQLite wrapper passed an outer temporary filename into an already-atomic
helper, renamed the file, and retained the obsolete temporary path in its
manifest metadata.

Correction:

Pass the final `.sqlite3` destination to the common atomic builder and forcibly
normalize manifest `path` and `filename` to the final relative filename.

Do not weaken `verify-shards.py`; the verifier is correctly reporting a stale
manifest path.

## Database process exits with code 3

Exit code 3 indicates a verification-stage failure in the database tools.

Inspect:

```text
static/data/.db.staging/reports/
static/data/db/reports/
```

and the failing verifier output. Common causes include:

- stale shard paths;
- missing shard files;
- size-limit violations;
- checksum mismatches;
- SQLite integrity failures;
- MariaDB/SQLite parity mismatches; and
- malformed manifests.

A failed staging tree must be rebuilt with `--clean`.

## Final status is failed although statistics or icons succeeded

The final status reflects all coordinated components. If the database component
fails, the public status is correctly marked failed even when statistics and
icons succeeded.

Read the component table in the final workflow summary and inspect the failed
job directly.

---

# Manual operation

## Run the full database refresh

From the GitHub Actions interface:

```text
Actions
  -> Update Speciedex Public Database
  -> Run workflow
```

Provide an optional request ID and origin.

## Run only the archive scan

```text
Actions
  -> Update Taxonomic Archive
  -> Run workflow
```

This performs one registry-wide `--all-providers` pass over all currently
executable providers.

## Run only the icon build

```text
Actions
  -> Update Speciedex Icons
  -> Run workflow
```

Select:

- force rebuild or incremental mode;
- master icon size;
- optional request metadata;
- rejection limits when non-default thresholds are justified.

## Trigger the terminal path manually

```text
Actions
  -> Terminal Full Database Update Request
  -> Run workflow
```

This is the preferred test for queued and final public status behavior.

---

# Local validation

Validate workflow YAML using a YAML 1.2-capable parser.

Compile Python tools:

```bash
python -m py_compile \
  static/tools/stat-grabber.py \
  static/tools/database/*.py \
  static/tools/icon-forge.py \
  static/tools/icon-forge/*.py
```

Validate the provider registry:

```bash
python -m json.tool \
  static/tools/providers.json \
  >/dev/null
```

Validate shell syntax by extracting each `run:` block or by using the repository
workflow validator when present.

Run database products locally:

```bash
python static/tools/database/update-databases.py \
  --taxonomy-root static/data/taxonomy \
  --db-root static/data/db \
  --clean \
  --verify \
  --publish \
  --strict-records \
  --verbose
```

Normalize canonical taxonomy locally:

```bash
python static/tools/icon-forge/normalize-taxonomy.py \
  --input static/data/taxonomy/volumes \
  --output static/data/taxonomy/normalized/all-taxa.jsonl \
  --rejected static/data/taxonomy/rejected/invalid-records.jsonl \
  --report static/data/icons/normalization-report.json \
  --expected-min-records 1
```

Review the rejection report before committing generated products.

---

# Maintenance checklist

Before changing a reusable workflow:

1. compare every caller `with:` key against the callee's
   `workflow_call.inputs`;
2. compare every referenced output against the callee's declared outputs;
3. validate YAML;
4. run Bash syntax checks on every `run:` block;
5. compile embedded Python heredocs;
6. compile referenced Python tools;
7. search for undefined shell variables under `set -u`;
8. preserve the one-command `--all-providers` contract;
9. preserve the 77-provider registry-accounting invariant;
10. confirm generated paths are owned by only one publishing job;
11. confirm bot commits cannot trigger infinite workflow loops;
12. confirm transient SQLite and lock files are excluded;
13. confirm status publication runs under `if: always()`; and
14. perform a manual end-to-end run before relying on the scheduled trigger.

Before changing provider definitions:

1. keep the provider count at exactly 77;
2. keep names unique and canonical;
3. ensure the module imports;
4. ensure the provider class and name agree;
5. ensure a fetch implementation exists;
6. declare required environment variables explicitly;
7. declare file-backed dataset paths explicitly;
8. avoid embedding credentials;
9. update provider documentation; and
10. verify executable/blocked accounting still totals 77.

Before changing icon normalization:

1. preserve canonical terminal identifiers;
2. preserve lineage expansion;
3. preserve deterministic intermediate IDs;
4. preserve global deduplication;
5. validate source-record counts;
6. validate unique-taxa output counts;
7. quarantine malformed records;
8. keep rejection thresholds explicit;
9. never assume source and normalized counts are equal; and
10. keep the normalization report in generated products.

---

# Ownership boundaries

| Path | Owning workflow |
|---|---|
| `static/data/statistics*.json` | `update-statistics.yml` |
| `static/data/taxonomy/manifest.json` | `update-statistics.yml` |
| `static/data/taxonomy/volumes/` | `update-statistics.yml` |
| `static/data/taxonomy/provider-state/` | `update-statistics.yml` |
| `static/data/taxonomy/normalized/` | `update-icons.yml` |
| `static/data/taxonomy/rejected/` | `update-icons.yml` |
| `static/data/icons/` | `update-icons.yml` |
| `static/images/taxa/` | `update-icons.yml` |
| `static/data/db/` | `update-database.yml` |
| `static/data/terminal-update-status.json` | terminal and database workflows |

Avoid having multiple jobs commit the same generated path unless the ownership
and synchronization rules are explicitly redesigned.

---

# Design principles

The workflow system follows these principles:

- canonical taxonomy is authoritative;
- derived products are reproducible;
- provider selection is disabled for full public refreshes;
- registry coverage and runtime availability are separate concepts;
- malformed records are visible and bounded, not silently discarded;
- database publication is atomic;
- generated products are verified before publication;
- every public request receives queued and final status;
- no credential is stored in the repository;
- generated commits are attributable to dedicated bots; and
- every failure should identify the exact component and corrective action.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D  
Licensed under the MIT License.
