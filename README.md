# Speciedex

**Open-source, Bitcoin-native biodiversity infrastructure for indexing, validating, preserving, analyzing, and distributing the documented record of non-human life.**

[Speciedex.org](https://speciedex.org/) is the public gateway to a larger biodiversity-data architecture built around open schemas, provider provenance, reproducible data pipelines, cryptographic integrity, distributed operation, long-term archives, and independently verifiable software.

This repository contains the public Speciedex.org website together with the browser terminal, versioned static API artifacts, Python terminal/API backend, provider adapters, taxonomy pipeline, database builders, verification tools, automation workflows, documentation, visual assets, and the public-facing descriptions of the wider Speciedex ecosystem.

> **Permanent protocol boundary:** Speciedex is for non-human biodiversity. `Homo sapiens` is excluded by design. The project must not become a system for human biometric indexing, population tracking, genomic profiling, surveillance, or identity correlation.

---

## Contents

- [Purpose](#purpose)
- [Core principles](#core-principles)
- [The Speciedex ecosystem](#the-speciedex-ecosystem)
- [What this repository contains](#what-this-repository-contains)
- [Architecture](#architecture)
- [Canonical taxonomy pipeline](#canonical-taxonomy-pipeline)
- [Provider system](#provider-system)
- [Database architecture](#database-architecture)
- [SpeciedexTerminal](#speciedexterminal)
- [Terminal API](#terminal-api)
- [Static API and GitHub Pages](#static-api-and-github-pages)
- [Assertion volumes](#assertion-volumes)
- [Bitcoin and Lightning](#bitcoin-and-lightning)
- [Repository layout](#repository-layout)
- [Local development](#local-development)
- [Python terminal API](#python-terminal-api)
- [Database build and verification](#database-build-and-verification)
- [Testing and validation](#testing-and-validation)
- [Automation](#automation)
- [Deployment](#deployment)
- [Security and secrets](#security-and-secrets)
- [Data integrity and provenance](#data-integrity-and-provenance)
- [Data and licensing](#data-and-licensing)
- [Contributing](#contributing)
- [Project status](#project-status)
- [Maintainer](#maintainer)
- [License](#license)

---

## Purpose

Speciedex is designed to organize biodiversity knowledge as durable public infrastructure rather than as a single website or proprietary database.

The project brings together taxonomy, source-provider assertions, scientific metadata, observations, literature, specimens, genetics, media, conservation information, geographic data, provenance, revision history, checksums, manifests, and archival products through a common set of identifiers and validation rules.

The long-term goal is a system in which biodiversity information can be:

- inspected rather than merely displayed;
- traced to its source rather than detached from provenance;
- validated and compared across independent providers;
- preserved through revisions instead of silently overwritten;
- exported in open machine-readable formats;
- reproduced from canonical source data;
- mirrored and verified independently;
- analyzed through web, terminal, API, database, and research interfaces;
- preserved in historical snapshots and bounded archival volumes;
- funded and operated without requiring a proprietary token.

Speciedex is intended for researchers, taxonomists, conservationists, universities, museums, biological repositories, archives, environmental organizations, developers, educators, students, citizen scientists, public institutions, and the general public.

---

## Core principles

### Open scientific infrastructure

Source code, schemas, policies, examples, tests, provider documentation, manifests, reports, database tools, API artifacts, and public interfaces should remain inspectable and independently reproducible wherever licensing permits.

### Canonical source before generated databases

The canonical filesystem taxonomy under `static/data/taxonomy/` is the source of truth. SQLite, MariaDB, search indexes, statistics, manifests, API products, and terminal datasets are derived products.

### Provenance before convenience

Imported values should retain enough metadata to identify their source provider, source identifier, retrieval time, licensing context, transformation history, validation state, and deterministic identity.

### Append history; do not erase it

Taxonomic revisions, corrections, conflicting assertions, supersession, validation outcomes, and retractions should remain auditable. Canonical state is derived from recorded history rather than created by deleting that history.

### Independent verification

Published artifacts should be verifiable through deterministic identifiers, manifests, checksums, parity tests, schema validation, and reproducible build procedures.

### No proprietary project token

Speciedex is Bitcoin-native but does not require a proprietary cryptocurrency or speculative asset. Bitcoin and Lightning are the monetary layers where digital settlement is useful.

### Non-human scope

The protocol boundary excluding `Homo sapiens` is permanent. Species infrastructure must not be repurposed into human surveillance infrastructure.

---

## The Speciedex ecosystem

The public site describes thirteen coordinated systems. Speciedex is the umbrella project and common identity; twelve specialized platforms address different operational functions.

| Platform | Role |
|---|---|
| **Speciedex** | Complete biodiversity concept, public species index, common identifiers, canonical records, and shared operating model. |
| **SpeciedexCore** | Core libraries, data models, normalization, validation, indexing, canonical identity, and node/server engine. |
| **SpeciedexExplorer** | Interactive discovery, comparison, visualization, historical replay, and research interface. |
| **SpeciedexNet** | Distributed peer-to-peer synchronization, transport, relaying, mirroring, and preservation layer. |
| **SpeciedexWeb** | Browser-based public gateway for exploring the published dataset without operating a node. |
| **SpeciedexTerminal** | Terminal-style interface for searching, inspecting, validating, exporting, diagnosing, and visualizing Speciedex data. |
| **SpeciedexLibrary** | Scientific literature, citations, documentation, field guides, reports, datasets, and legally accessible reference material. |
| **SpeciedexArchives** | Long-term preservation of provider snapshots, datasets, schemas, metadata, documents, checksums, reports, and recovery packages. |
| **SpeciedexGeneticBank** | Non-human genetic-data references linking species with genomes, genes, sequences, markers, accessions, specimens, repositories, and publications. |
| **SpeciedexAnalysis** | Reproducible comparison, data-quality analysis, provider reconciliation, historical analysis, statistics, and modeling. |
| **SpeciedexMaps** | Species distributions, occurrences, habitats, ecological regions, protected areas, provider coverage, uncertainty, and historical geospatial change. |
| **SpeciedexApp** | Field, mobile, desktop, public-access, synchronization, and offline-oriented client concepts. |
| **SpeciedexAPI** | Versioned machine-readable interface for querying, validating, exporting, streaming, and integrating Speciedex data. |

Not every ecosystem concept is necessarily a finished standalone product in this repository. This repository is the public website and a substantial part of the common tooling, browser terminal, provider pipeline, generated data system, and API infrastructure used to implement and document that architecture.

---

## What this repository contains

The repository currently includes:

- a static public website suitable for GitHub Pages;
- modular HTML partials for the principal Speciedex pages;
- shared CSS and JavaScript loaders;
- logos, icons, fonts, imagery, and other public assets;
- the browser-based SpeciedexTerminal;
- terminal command modules for taxonomic ranks, providers, archives, statistics, maps, timelines, graphs, matrices, and other visualizations;
- Web Worker modules for search, indexing, maps, providers, statistics, libraries, timelines, and filtering;
- a Python terminal/API backend;
- GitHub Pages-compatible generated API JSON under `api/speciedex/v1/`;
- 77 configured provider adapters and associated policies, schemas, examples, documentation, and tests;
- the canonical taxonomy filesystem pipeline;
- SQLite and MariaDB build, import, reconciliation, parity, manifest, checksum, and shard tooling;
- browser search indexes and routing metadata;
- provider state, revisions, conflicts, rejected records, and bounded taxonomy volumes;
- GitHub Actions workflows for database, terminal API, statistics, icons, and related generated products;
- an nginx configuration for local or self-hosted static serving.

The repository is intentionally usable as a static public front end while retaining Python tooling for ingestion, build automation, database generation, API hosting, and other operations that cannot execute on GitHub Pages.

---

## Architecture

At a high level, Speciedex separates source collection, canonical taxonomy, generated databases, static publication, browser clients, and optional live services.

```text
                              upstream providers
                                      |
                                      v
                     static/tools/providers/*.py
                                      |
                                      v
                     static/data/taxonomy/raw/
                                      |
                       validation + normalization
                                      |
                                      v
                static/data/taxonomy/normalized/
                                      |
                 deduplication + reconciliation
                       /              |              \
                      v               v               v
               revisions/         conflicts/       rejected/
                      \               |               /
                       \              |              /
                                      v
                           canonical taxonomy
                                      |
                 +--------------------+--------------------+
                 |                    |                    |
                 v                    v                    v
          SQLite shards       MariaDB exports      browser indexes
                 |                    |                    |
                 +--------------------+--------------------+
                                      |
                                      v
                           manifests + checksums
                                      |
                 +--------------------+--------------------+
                 |                    |                    |
                 v                    v                    v
          SpeciedexTerminal     SpeciedexAPI        website/tools
                 |                    |                    |
                 +--------------------+--------------------+
                                      |
                                      v
                              public releases
```

A key invariant is that database products are rebuildable. Generated SQLite or MariaDB data is not permitted to become an independent authority that silently diverges from the canonical taxonomy.

---

## Canonical taxonomy pipeline

The canonical taxonomy lives under:

```text
static/data/taxonomy/
```

Important stages include:

```text
raw/              immutable provider payloads and source archives
normalized/       normalized records after mapping and validation
rejected/         records that failed validation or could not be processed
provider-state/   provider cursors, timestamps, hashes, and ingestion state
revisions/        append-oriented canonical record revision history
conflicts/        unresolved reconciliation conflicts and evidence
volumes/          bounded archival/publication volumes
manifest.json     taxonomy catalog and aggregate state
scheduler.json    provider scheduling and update cadence
```

The intended data flow is:

```text
77 providers
    -> raw
    -> normalize / validate
    -> deduplicate / reconcile
    -> canonical records
    -> revisions + conflicts + volumes
    -> SQLite + MariaDB
    -> indexes + statistics + icons + API + terminal
```

Canonical records are expected to retain stable Speciedex identity, names, rank, status, lineage, provider assertions, timestamps, licensing/provenance metadata, and deterministic hashes.

Direct edits to generated database products are not the normal publication path. Changes imported from a database must be reconciled back into the canonical taxonomy and then regenerated into all supported database products.

---

## Provider system

The provider registry is stored at:

```text
static/tools/providers.json
```

The current registry contains **77 configured provider adapters**. Provider modules live under:

```text
static/tools/providers/
```

The system supports multiple provider roles, including taxonomy, global checklists, occurrence data, conservation, marine biology, botany, fungi, microbiology, virology, genetics, literature, protected areas, geography, linked data, and general enrichment.

The provider registry includes operational metadata such as adapter/module identity, enablement, priority, batch size, rate limits, endpoint information, documentation, schema references, and verification state.

**Configured does not mean permanently reachable or contractually unrestricted.** Upstream APIs, authentication requirements, data licenses, schemas, quotas, URLs, and terms can change. Provider verification and licensing must be maintained as part of ingestion operations.

<details>
<summary><strong>Configured provider IDs (77)</strong></summary>

```text
wikipedia
wikispecies
gbif
itis
worms
inaturalist
wikidata
catalogue_of_life
open_tree_of_life
eol
iucn_red_list
iucn_green_status
iucn_green_list
ncbi_taxonomy
world_flora_online
powo
ipni
tropicos
grin_taxonomy
usda_plants
euro_med_plantbase
zoobank
index_fungorum
mycobank
species_fungorum
irmng
fishbase
sealifebase
algaebase
paleobiology
bold
global_names
gnub
obis
ebird
avibase
ioc_world_bird_list
mammal_diversity_database
reptile_database
amphibiaweb
amphibian_species_world
ala
canadensys
idigbio
natureserve
species_plus
cms_species
silva
unite
gtdb
lpsn
bacdive
ictv
viralzone
genbank
ena
uniprot_taxonomy
antweb
antcat
orthoptera_species_file
odonata_central
world_spider_catalog
molluscabase
world_echinoderm_database
bryozoa_net
fao_asfis
plazi_treatmentbank
biodiversity_heritage_library
crossref
openalex
geonames
marine_regions
wdpa
key_biodiversity_areas
darwin_core_archive
generic_jsonl
youtube
```

</details>

Public browser code should consume published Speciedex products. It should not embed private credentials or treat direct browser calls to upstream providers as the primary data architecture.

---

## Database architecture

Database-generation tools live under:

```text
static/tools/database/
```

Generated database products live under:

```text
static/data/db/
```

The database system produces and maintains:

- SQLite shards;
- MariaDB-compatible logical exports;
- browser lookup indexes;
- shard routing metadata;
- manifests;
- provider metadata;
- build state;
- checksums;
- update streams;
- integrity reports;
- parity reports.

### SQLite

SQLite is the browser/query-oriented database product. The browser terminal uses lightweight indexes and SQLite-compatible shard routing rather than connecting directly to MariaDB.

### MariaDB

MariaDB products are intended for server deployment, replication, backups, analytics, and other server-side operations.

### Parity rule

SQLite and MariaDB are derived from the same canonical taxonomy and are expected to represent the same canonical records. The database toolchain includes parity verification so one representation cannot quietly drift from the other.

### Repository-size rule

Database and API products are sharded or volume-bounded so individual generated files remain compatible with repository/publication limits. Large monolithic data files should not be reintroduced when the repository already defines a shard or volume mechanism.

---

## SpeciedexTerminal

The browser terminal is implemented primarily under:

```text
static/js/terminal/
```

It is a modular browser client rather than a direct upstream-provider crawler. It consumes published Speciedex data and terminal API products.

Major module groups include:

```text
archive/          manifests, checksums, releases, source assertions, volumes
providers/        provider lists, assertions, documentation, errors, overlap,
                  latency, statistics, provider-specific species
 taxa/            domains, kingdoms, phyla, classes, orders, families, genera,
                  species, subspecies, varieties, tribes, clades, forms, ranks
visualization/    globe, maps, phylogeny, networks, matrices, density, radial,
                  range maps, stream graphs, taxonomy tree, time slider, etc.
workers/          background search, indexes, filters, maps, provider queries,
                  statistics, library work, and timelines
```

Additional terminal modules provide command routing, history, settings, exports, imports, tables, maps, graphs, timelines, bookmarks, status views, storage, keyboard interaction, themes, layouts, and API access.

### Species-list ordering

The default terminal species-list presentation is intentionally randomized rather than implicitly alphabetical. Explicit user-requested sorting remains available. This keeps the default terminal output from presenting the same alphabetically biased slice of biodiversity on every request.

---

## Terminal API

The headless terminal/API implementation lives under:

```text
static/tools/terminal/
static/tools/terminal-api.py
static/tools/terminal-api-cli.py
static/tools/terminal-apid.py
```

It supports two complementary modes:

1. a live Python HTTP service; and
2. generated static JSON artifacts suitable for GitHub Pages.

The default API namespace is:

```text
/api/speciedex/v1/
```

The live backend provides routes including:

```text
GET  /api/speciedex/v1/
GET  /api/speciedex/v1/health
GET  /api/speciedex/v1/stats
GET  /api/speciedex/v1/providers
GET  /api/speciedex/v1/routes
GET  /api/speciedex/v1/search?q=...
POST /api/speciedex/v1/search
GET  /api/speciedex/v1/manifests
GET  /api/speciedex/v1/checksums
GET  /api/speciedex/v1/benchmark
GET  /api/speciedex/v1/stream
```

Some capabilities, particularly live search behavior and streaming/SSE, require a live backend. GitHub Pages can only serve pre-generated static artifacts.

---

## Static API and GitHub Pages

GitHub Pages does not execute Python. The repository therefore generates a static representation of the API under:

```text
api/speciedex/v1/
```

Typical public products include:

```text
health.json
index.json
manifest.json
providers.json
routes.json
stats.json
SHA256SUMS
providers/...
```

The browser client can fetch these files directly from the same origin.

Generate the Pages-compatible API with:

```bash
python static/tools/terminal-api.py --generate-static
```

The GitHub Actions workflow `.github/workflows/update-terminal-api.yml` validates the Python sources, runs terminal API tests, performs the backend health check, regenerates static API artifacts, writes SHA-256 checksums, and publishes changed artifacts.

---

## Assertion volumes

Provider assertions can become too large for practical repository hosting as a single JSON document. The provider-assertion endpoint therefore uses a small wrapper/index plus four bounded JSON volumes:

```text
api/speciedex/v1/providers/assertions.json
api/speciedex/v1/providers/assertions-0001.json
api/speciedex/v1/providers/assertions-0002.json
api/speciedex/v1/providers/assertions-0003.json
api/speciedex/v1/providers/assertions-0004.json
```

`assertions.json` is the stable entry point. Consumers that understand the volume manifest can load the four constituent files and reassemble the complete assertion collection without changing the external path used to discover the dataset.

The static API builder is responsible for preserving this four-volume layout during regeneration. Do not replace the wrapper with a monolithic assertion payload.

---

## Bitcoin and Lightning

Speciedex is Bitcoin-native in the sense that the project favors open settlement, independent verification, durable identifiers, transparent funding, and infrastructure that does not require a central payment operator.

Potential and documented uses include:

- donations;
- contributor compensation;
- data bounties;
- research funding;
- archival sponsorship;
- infrastructure and node support;
- Lightning payments for appropriate low-value or frequent transactions;
- cryptographic commitments, hashes, signed manifests, and timestamp-related research where technically appropriate.

Bitcoin-related integrity mechanisms are supplementary to scientific provenance, source citation, archival practice, and reproducible data processing. They do not replace those scientific requirements.

Speciedex does **not** require a proprietary token.

Nothing in this repository should be interpreted as financial, investment, tax, custody, or legal advice.

---

## Repository layout

A simplified repository map:

```text
.
├── .github/
│   └── workflows/                  GitHub Actions automation
├── _partials/
│   ├── header.html
│   ├── footer.html
│   ├── nav.html
│   └── pages/                      modular page sections
├── api/
│   └── speciedex/v1/               generated Pages-compatible API
├── about/
├── bitcoin/
├── bitcoin-smart-contracts/
├── contact/
├── creator/
├── credits/
├── donate/
├── history/
├── home/
├── landing-page/
├── lightning-network/
├── mission/
├── speciedex/
├── speciedexanalysis/
├── speciedexapi/
├── speciedexapp/
├── speciedexarchives/
├── speciedexcore/
├── speciedexexplorer/
├── speciedexgeneticbank/
├── speciedexlibrary/
├── speciedexmaps/
├── speciedexnet/
├── speciedexterminal/
├── speciedexweb/
├── static/
│   ├── css/                         shared and component CSS
│   ├── data/
│   │   ├── db/                      generated database products
│   │   └── taxonomy/                canonical taxonomy filesystem
│   ├── fonts/
│   ├── icons/
│   ├── images/
│   ├── js/
│   │   └── terminal/                browser terminal implementation
│   ├── logos/
│   ├── tools/
│   │   ├── database/                database build/verify/import pipeline
│   │   ├── providers/               provider adapters
│   │   ├── terminal/                Python terminal/API backend
│   │   └── tests/                   Python tests
│   ├── script.js                    public JavaScript entry wrapper
│   └── styles.css                   public CSS entry wrapper
├── .nojekyll
├── CNAME
├── LICENSE
├── nginx.conf
├── index.html
├── robots.txt
└── README.md
```

The HTML pages deliberately share a common include system. Page content is separated into `_partials/pages/<page>/...` rather than copied into every `index.html`.

---

## Local development

### Requirements

For the static website itself, a modern browser and ordinary HTTP server are sufficient. Do not rely on opening `index.html` directly with a `file://` URL because the site uses `fetch()`-driven partials and JSON resources.

For Python tooling and CI parity, use **Python 3.13** where practical; the terminal API workflow is tested against Python 3.13.

No Node/npm build step is required for the public site.

### Quick static server

From the repository root:

```bash
python -m http.server 8000
```

Then open:

```text
http://127.0.0.1:8000/
```

This is adequate for inspecting the static website and generated static API products.

### nginx

The repository includes `nginx.conf` for a more production-like local or self-hosted static deployment. It defines caching behavior, static paths, security headers, partial handling, and content types for the public site.

Adapt filesystem paths, TLS, logging, and reverse-proxy settings for the target host rather than treating the checked-in configuration as a universal machine-specific configuration.

---

## Python terminal API

Run a backend health check:

```bash
python static/tools/terminal-api.py --check
```

Generate the static API:

```bash
python static/tools/terminal-api.py --generate-static
```

Run the live API locally:

```bash
python static/tools/terminal-api.py --host 127.0.0.1 --port 8765
```

The CLI wrapper also supports operations such as:

```bash
python static/tools/terminal-api-cli.py check
python static/tools/terminal-api-cli.py build-static
python static/tools/terminal-api-cli.py call health
```

The daemon wrapper supports:

```bash
python static/tools/terminal-apid.py start
python static/tools/terminal-apid.py status
python static/tools/terminal-apid.py restart
python static/tools/terminal-apid.py stop
python static/tools/terminal-apid.py foreground
```

For a self-hosted deployment, `/api/speciedex/v1/` can be reverse-proxied to the live API service. For GitHub Pages, keep the generated static `api/speciedex/v1/` tree in the published repository.

---

## Database build and verification

The primary database entry point is:

```bash
python static/tools/database/build-databases.py
```

Incremental update:

```bash
python static/tools/database/update-databases.py
```

Verify generated shards:

```bash
python static/tools/database/verify-shards.py
```

Verify SQLite/MariaDB parity:

```bash
python static/tools/database/verify-database-parity.py
```

Other database tools support:

- SQLite shard generation;
- MariaDB export generation;
- browser index generation;
- manifest generation;
- SQLite import;
- MariaDB import;
- database reconciliation;
- shard verification;
- checksums and reports.

Publication should fail rather than knowingly publish a corrupted, incomplete, or parity-broken database build.

---

## Testing and validation

### Terminal API Python tests

```bash
python -m unittest discover \
  -s static/tools/tests \
  -p 'test_terminal_api.py' \
  -v
```

### Python syntax/bytecode validation

```bash
python -m compileall -q static/tools/terminal
python -m py_compile \
  static/tools/terminal-api.py \
  static/tools/terminal-api-cli.py \
  static/tools/terminal-apid.py
```

### Browser terminal JavaScript syntax checks

When Node is available for syntax validation:

```bash
node --check static/js/terminal/taxa/*.js
node --check static/js/terminal/providers/*.js
```

Node is not required as the application's runtime or build system; these commands are useful only as JavaScript syntax checks.

### Database verification

```bash
python static/tools/database/verify-shards.py
python static/tools/database/verify-database-parity.py
```

### Static API JSON validation

Generated JSON artifacts should be parseable and checksummed before publication. The terminal API workflow performs validation as part of its build process.

---

## Automation

The repository includes GitHub Actions workflows under:

```text
.github/workflows/
```

Current workflow responsibilities include:

- terminal/API artifact generation;
- database generation and publication;
- statistics updates;
- icon updates;
- terminal update/status coordination;
- related server or visualization support tasks.

Generated artifacts should be produced by deterministic tooling and committed only when they actually change.

Automation must never commit credentials, API secrets, private tokens, local environment files, or sensitive provider authentication material.

---

## Deployment

### GitHub Pages

The repository is structured for static publication and includes:

```text
.nojekyll
CNAME
```

The `CNAME` configures the public domain:

```text
speciedex.org
```

Because Pages is static, Python work must happen before publication through local tooling, CI, or another backend. The result is then committed as ordinary static files.

### Self-hosted static site

Serve the repository root with an HTTP server or nginx. Ensure `_partials/`, `static/`, and `api/` remain directly fetchable.

### Self-hosted live API

Run `static/tools/terminal-api.py` or `terminal-apid.py` and reverse-proxy the API prefix to the backend service while the remainder of the site remains static.

A production deployment should add HTTPS, host-specific paths, process supervision, access controls where necessary, backup procedures, monitoring, and deployment-specific security policy.

---

## Security and secrets

The public repository must not contain:

- API keys;
- provider passwords;
- access tokens;
- private keys;
- wallet recovery material;
- authentication cookies;
- private database credentials;
- CI secrets;
- local `.env` contents;
- private user or contributor data.

Provider authentication belongs in local/server-side Python tooling and CI secret storage, not browser JavaScript or committed JSON.

The public terminal is a read-oriented client of published Speciedex products. Secret-bearing ingestion should remain separate from public browser execution.

For security reports, use the project's published contact/responsible-disclosure channels rather than posting exploitable secrets or sensitive reports into public issues.

---

## Data integrity and provenance

Speciedex treats provenance as part of the data model rather than as optional documentation.

Published records and generated products should preserve, where applicable:

- stable Speciedex identifiers;
- upstream provider identifiers;
- scientific and canonical names;
- authorship and nomenclatural authority;
- taxonomic rank and lineage;
- accepted/synonym/disputed status;
- provider assertions;
- source URLs and citations;
- retrieval and modification timestamps;
- licensing metadata;
- transformation history;
- validation and conflict state;
- deterministic hashes;
- manifests and checksums;
- revision and supersession history.

The project can therefore expose a current canonical view without pretending that taxonomy has no history, disagreement, or uncertainty.

---

## Data and licensing

The **software in this repository** is licensed under the MIT License; see [`LICENSE`](LICENSE).

The repository also references, transforms, indexes, or republishes information originating from many independent biodiversity, scientific, conservation, geographic, bibliographic, media, and public-data providers. Those upstream datasets, media files, publications, trademarks, and APIs may have their own licenses, attribution requirements, access conditions, or terms of use.

The MIT software license does **not** automatically relicense third-party data.

When adding or updating provider-derived material:

1. preserve source attribution and provider identity;
2. record applicable licensing/provenance metadata;
3. respect provider access and redistribution terms;
4. do not commit material that the project lacks permission to redistribute;
5. distinguish software licensing from data/content licensing.

---

## Contributing

Contributions should preserve the architecture rather than bypass it.

For code changes:

1. keep modules focused and readable;
2. preserve existing public paths unless a migration is intentional;
3. do not add unnecessary build dependencies to the static front end;
4. keep browser code free of secrets;
5. validate JavaScript and Python syntax;
6. add or update tests when behavior changes;
7. regenerate manifests/checksums when generated data changes;
8. verify database parity when database products change;
9. preserve provider provenance and licensing metadata;
10. keep large generated datasets sharded or volume-bounded.

For taxonomy/data changes, modify or import through the canonical taxonomy pipeline. Do not patch generated SQLite or MariaDB products as though they were the authoritative source.

For provider work, update the relevant adapter, schema, policy, documentation, tests, and verification metadata together when applicable.

For public-site work, retain the shared partial/include architecture and test pages through HTTP rather than `file://` loading.

---

## Project status

Speciedex is under active development.

The repository combines working public-site infrastructure and data tooling with broader ecosystem components that are still being implemented, expanded, validated, populated, or documented. Provider availability and verification can change independently of repository code, and large-scale taxonomy ingestion is an ongoing process rather than a one-time build.

Accordingly, do not interpret the existence of a documented subsystem, provider adapter, route, schema, or planned species-chain feature as evidence that every part of that subsystem is complete or production-ready.

The preferred development direction is incremental, reproducible completion: every generated product should have a defined source, every source should preserve provenance, every database should be rebuildable, and every public interface should consume the same verified underlying state.

---

## Maintainer

**0xdeadbeef of ZZX-Labs R&D**

Project website: [https://speciedex.org/](https://speciedex.org/)

---

## License

```text
MIT License
Copyright (c) 2026 ZZX-Labs R&D
```

See [`LICENSE`](LICENSE) for the complete license text.

---

## Summary

Speciedex is an attempt to treat biodiversity knowledge as infrastructure: open enough to inspect, structured enough to compute with, historical enough to audit, distributed enough to preserve, and reproducible enough to verify.

The website is only one interface. The deeper system is the relationship among canonical taxonomy, provider assertions, provenance, validation, databases, archives, APIs, terminal tools, maps, literature, genetics, analysis, distributed mirrors, and public access.

The governing technical rule is simple:

> **Preserve the source. Preserve the history. Preserve the provenance. Generate everything else reproducibly.**
