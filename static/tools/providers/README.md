# Speciedex Provider Modules

The `static/tools/providers/` package contains the source adapters used by the
Speciedex ingestion pipeline. Every provider registered in
`static/tools/providers.json` must have a matching Python module in this
directory and a `Provider` class derived from
`providers.common.BaseProvider`.

The registry currently contains **77 enabled providers**. Enabled
means that the provider is part of the Speciedex provider ecosystem. It does
not mean that the provider is guaranteed to run during every scan. Runtime
eligibility is determined separately from module presence, required
credentials, required local datasets, configured paths, dependencies,
scheduler state, cooldowns, and provider health.

## Package layout

```text
static/tools/providers/
├── __init__.py
├── common.py
├── loader.py
├── README.md
├── schemas/
│   └── <provider>.schema.json
├── <provider>.py
└── ...
```

The loader dynamically imports the module declared by each provider registry
entry. The default module convention is:

```text
providers.<provider-name>.Provider
```

A provider module must export a class with the following minimum contract:

```python
from providers.common import BaseProvider, Batch, Taxon

class Provider(BaseProvider):
    PROVIDER_NAME = "example_provider"

    def fetch(self) -> Batch:
        ...

    def normalize_record(self, value) -> Taxon:
        ...
```

`PROVIDER_NAME` must exactly match the provider's `name` in
`static/tools/providers.json`. Provider names use lowercase ASCII letters,
numbers, and underscores.

## Provider execution model

The ingestion path is:

```text
providers.json
      ↓
ProviderManager
      ↓
provider module
      ↓
Batch
      ↓
Taxon validation and normalization
      ↓
reconciliation
      ↓
canonical archive
      ↓
SQLite index, statistics, manifests, history, and reports
```

Each provider returns a `Batch` containing normalized `Taxon` records and a
resumable cursor. A provider must not write directly to the canonical archive.
Archive mutation, reconciliation, revision handling, conflict handling, state
persistence, and statistics belong to the core ingestion layer.

## Enabled versus eligible

All registered providers are enabled:

```json
"enabled": true
```

The provider manager then evaluates runtime prerequisites. An enabled provider
can still be skipped for one of these reasons:

```text
missing dataset
missing credentials
missing dependency
disabled by explicit maintenance policy
cooldown or health backoff
missing provider module
invalid provider configuration
```

Dataset-backed providers remain enabled even when their files are absent. They
become eligible automatically when the configured dataset appears.

Credential-backed providers remain enabled even when their environment
variables are absent. They become eligible automatically when the required
secrets are available.

This separation prevents temporary operational conditions from being confused
with permanent removal from the registry.

## Provider categories

### Direct API providers

These modules currently perform live provider-specific network requests and
normalize upstream responses directly:

```text
gbif.py
inaturalist.py
itis.py
wikipedia.py
wikispecies.py
worms.py
youtube.py
```

The MediaWiki providers use continuation cursors. Wikispecies separates page
discovery from page enrichment so generator queries are not mixed with
single-page-only revision parameters.

ITIS accepts JSON or XML and advances through TSNs one record at a time. Empty
successful responses are treated as unused TSNs, while malformed, HTML, or
service-error responses do not advance the cursor.

### Dataset-backed provider modules

Many provider modules currently ingest normalized and licensed JSONL exports.
Their registry records contain a `path` such as:

```text
static/data/import/<provider>.jsonl
```

These providers remain enabled but are skipped until the source file exists.
This is intentional. The provider-specific module remains the normalization
boundary even when acquisition is performed by a separate downloader,
licensing workflow, bulk-release process, or preprocessing tool.

### Generic adapters

`generic_jsonl.py` ingests a configured normalized JSONL source using the
common `Taxon` contract.

`darwin_core_archive.py` ingests Darwin Core Archive ZIP files or extracted
DwC-A directories. The configured path must exist before it becomes eligible.
The adapter reads `meta.xml`, resolves core and extension files, maps Darwin
Core terms, preserves source provenance, and emits normalized taxa.

## Common provider contract

Every emitted `Taxon` should provide, when available:

```text
provider
provider_id
scientific_name
canonical_name
rank
status
authorship
kingdom
phylum
class_name
order
family
genus
accepted_provider_id
source_url
source_modified
retrieved_at
synonyms
extra
```

`provider` must equal the registry name. `provider_id` must be stable within the
provider. `scientific_name`, `canonical_name`, `rank`, and `status` must be
nonempty after provider normalization.

Lineage fields are important even for species-level records. Site statistics
for kingdoms, phyla, classes, orders, families, and genera are computed from
both canonical higher-rank records and lineage values attached to lower-rank
records.

Provider-specific data belongs under `Taxon.extra`. The original decoded
provider object should normally be preserved under:

```python
Taxon.extra["raw"]
```

This allows future reprocessing without discarding provider evidence.

## Rank normalization

Providers should use the canonical Speciedex rank vocabulary whenever
possible. Common aliases are normalized by the core pipeline, including:

```text
regnum       → kingdom
division     → phylum
divisio      → phylum
classis      → class
ordo         → order
familia      → family
tribus       → tribe
sp.          → species
subsp.       → subspecies
ssp.         → subspecies
var.         → variety
forma        → form
```

Provider modules should still emit the most precise rank they can determine.
Unknown ranks should use `unknown` or `unranked` rather than inventing a
taxonomic level.

## Status normalization

The core pipeline normalizes common provider terminology into stable status
values. Typical outputs include:

```text
accepted
valid
synonym
reference
provisionally accepted
misapplied
excluded
inactive
unknown
```

A reference or enrichment source must not be treated as a formal nomenclatural
authority merely because it contains a taxonomic name.

## Cursor and pagination rules

A provider cursor must be deterministic, serializable, resumable, and advance
only after a batch has been accepted by the ingestion pipeline.

Supported cursor patterns include:

```text
numeric offsets
page numbers
opaque API continuation tokens
date-window cursors
provider identifiers
JSON-encoded structured state
```

Providers must detect unchanged or repeated continuation values. A provider
must raise `ProviderError` rather than returning an endlessly repeated cursor.

An empty but valid page may advance a cursor when the upstream source confirms
that the page, date window, identifier, or TSN is unused. Network failures,
malformed responses, authentication errors, HTML error pages, and schema
violations must not advance the cursor.

## HTTP behavior

Network providers use the shared HTTP client from `common.py` unless a provider
must support an additional response format, as ITIS does for XML.

Providers should:

- use the configured timeout, retry, and backoff settings;
- respect provider-specific rate limits;
- preserve request counts in `Batch.requests`;
- reject non-success HTTP status codes unless explicitly handled;
- detect HTML error pages returned with successful status codes;
- reject malformed nonempty JSON;
- allow empty bodies only when the endpoint contract makes them meaningful;
- avoid logging credentials, tokens, or full sensitive responses.

## Dataset paths

Relative paths are resolved from the repository root. The provider manager
checks these configuration keys:

```text
path
file
archive
source_path
database_path
sqlite_path
required_paths
```

A missing required path produces:

```text
missing dataset: <resolved-path>
```

A provider may declare:

```json
"path_optional": true
```

only when it can genuinely run without that path.

## Credentials

Credential-backed providers declare environment variables with `required_env`.
Examples include:

```text
EOL_API_KEY
IUCN_API_TOKEN
NATURESERVE_API_KEY
BACDIVE_USERNAME
BACDIVE_PASSWORD
BHL_API_KEY
GEONAMES_USERNAME
YOUTUBE_API_KEY
```

Missing values produce:

```text
missing credentials: <variable-list>
```

Secrets must be stored in GitHub Actions secrets or the deployment
environment. They must never be committed to `providers.json`, provider
modules, response schemas, fixtures, logs, or generated archives.

## Response schemas

Each provider may declare:

```json
"response_schema_path": "static/tools/providers/schemas/<provider>.schema.json"
```

Response schemas document request shape, record roots, field mappings,
pagination, authentication, examples, and verification state. A schema marked
`unverified` is documentation and a development checkpoint; it is not evidence
that the upstream contract has been tested.

Captured examples should be scrubbed of credentials and personal information
before they are committed.

## Registry commands

List current provider eligibility:

```bash
python static/tools/stat-grabber.py providers
```

Run the scheduled provider budget:

```bash
python static/tools/stat-grabber.py scan
```

Run all currently eligible providers:

```bash
python static/tools/stat-grabber.py scan --all-providers
```

Run selected providers:

```bash
python static/tools/stat-grabber.py scan \
  --provider gbif \
  --provider itis \
  --provider worms
```

Run with explicit operational limits:

```bash
python static/tools/stat-grabber.py scan \
  --batch-size 500 \
  --provider-budget 4 \
  --timeout 30 \
  --retries 4 \
  --backoff 2 \
  --volume-target-mb 48 \
  --volume-max-mb 90 \
  --history-limit 672 \
  --verbose
```

Rebuild the index and statistics from the complete archive:

```bash
python static/tools/stat-grabber.py reindex
```

Verify archive and index integrity:

```bash
python static/tools/stat-grabber.py verify
```

Recommended post-ingestion sequence:

```bash
python static/tools/stat-grabber.py scan
python static/tools/stat-grabber.py reindex
python static/tools/stat-grabber.py verify
```

## Provider development

A new provider requires:

```text
1. A registry entry in static/tools/providers.json.
2. A module in static/tools/providers/<name>.py.
3. Provider.PROVIDER_NAME matching the registry name.
4. A fetch() implementation returning Batch.
5. Normalization into the shared Taxon contract.
6. Cursor and exhaustion handling.
7. A response schema or field-mapping document.
8. Tests or captured fixtures.
9. Licensing and provenance documentation.
10. Verification against a current upstream response or bulk release.
```

Generated provider stubs are intentionally incomplete and must remain unusable
until `fetch()` and normalization are implemented. Do not enable a stub by
returning an empty successful batch. The module should raise
`NotImplementedError` or fail registry verification until it has a real
integration.

## Validation requirements

Before merging a provider:

```bash
python -m py_compile static/tools/providers/<provider>.py
python -m compileall -q static/tools/providers
python static/tools/stat-grabber.py providers
python static/tools/stat-grabber.py scan --provider <provider> --verbose
python static/tools/stat-grabber.py reindex
python static/tools/stat-grabber.py verify
```

The provider should be tested for:

```text
successful first page
successful continuation
empty valid page
unchanged continuation token
network timeout
rate limiting
HTTP 4xx and 5xx responses
malformed JSON or XML
HTML error response
missing credentials
missing dataset
missing required fields
synonym and accepted-name relationships
lineage preservation
raw source preservation
cursor persistence after success
cursor preservation after failure
```

## Licensing and provenance

Provider availability does not grant permission to redistribute upstream data.
Each integration must honor the provider's license, terms of use, attribution
requirements, API policies, download restrictions, and redistribution rules.

The canonical archive should retain enough provenance to identify:

```text
provider
provider record identifier
source URL
source modification time
retrieval time
dataset or release version
license or rights statement
normalization version
raw or source-derived evidence
```

Restricted datasets should not be committed to the public repository merely
because a provider module exists.

## Troubleshooting

### Provider is enabled but skipped

Run:

```bash
python static/tools/stat-grabber.py providers
```

Inspect the reported reason. Install the required dataset, add the required
credential, restore the provider module, or correct its configuration.

### Provider is eligible but fails during fetch

This indicates a runtime integration problem rather than a missing
prerequisite. Inspect the provider traceback, response status, content type,
cursor, and provider state. Do not convert malformed responses into empty
successful batches merely to keep the workflow green.

### Provider repeatedly fetches the same page

Check that `Batch.next_cursor` changes after successful ingestion and that the
provider detects repeated continuation tokens.

### Statistics show species but zero higher ranks

Confirm that providers populate lineage fields on species records. Rebuild the
index with:

```bash
python static/tools/stat-grabber.py reindex
```

Then verify that distinct lineage values in SQLite match the published
statistics.

### Darwin Core Archive remains eligible without an archive

Confirm that the registry entry declares its local `path`, that the final
`provider_manager.py` is installed, and that the configured path does not use
`path_optional: true`.

## Registered providers

| # | Module | Provider | Role | Integration | Runtime prerequisite |
|---:|---|---|---|---|---|
| 1 | `wikipedia.py` | Wikipedia | `reference_enrichment` | Direct API | public network/API |
| 2 | `wikispecies.py` | Wikispecies | `reference_taxonomy` | Direct API | public network/API |
| 3 | `gbif.py` | GBIF | `taxonomy_occurrence` | Direct API | public network/API |
| 4 | `itis.py` | ITIS | `taxonomy` | Direct API | public network/API |
| 5 | `worms.py` | WoRMS | `marine_taxonomy` | Direct API | public network/API |
| 6 | `inaturalist.py` | iNaturalist | `taxonomy_occurrence` | Direct API | public network/API |
| 7 | `wikidata.py` | Wikidata | `linked_data_enrichment` | Provider module / JSONL | dataset: `static/data/import/wikidata.jsonl` |
| 8 | `catalogue_of_life.py` | Catalogue of Life / ChecklistBank | `global_checklist` | Provider module / JSONL | dataset: `static/data/import/catalogue-of-life.jsonl` |
| 9 | `open_tree_of_life.py` | Open Tree of Life | `phylogeny_taxonomy` | Provider module / JSONL | dataset: `static/data/import/open-tree-of-life.jsonl` |
| 10 | `eol.py` | Encyclopedia of Life | `enrichment` | Provider module / JSONL | credentials: EOL_API_KEY; dataset: `static/data/import/eol.jsonl` |
| 11 | `iucn_red_list.py` | IUCN Red List | `conservation` | Provider module / JSONL | credentials: IUCN_API_TOKEN; dataset: `static/data/import/iucn-red-list.jsonl` |
| 12 | `iucn_green_status.py` | IUCN Green Status | `conservation_recovery` | Provider module / JSONL | credentials: IUCN_API_TOKEN; dataset: `static/data/import/iucn-green-status.jsonl` |
| 13 | `iucn_green_list.py` | IUCN Green List | `protected_areas` | Provider module / JSONL | credentials: IUCN_API_TOKEN; dataset: `static/data/import/iucn-green-list.jsonl` |
| 14 | `ncbi_taxonomy.py` | NCBI Taxonomy | `genetic_taxonomy` | Provider module / JSONL | dataset: `static/data/import/ncbi-taxonomy.jsonl` |
| 15 | `world_flora_online.py` | World Flora Online | `plant_taxonomy` | Provider module / JSONL | dataset: `static/data/import/world-flora-online.jsonl` |
| 16 | `powo.py` | Plants of the World Online | `plant_taxonomy` | Provider module / JSONL | dataset: `static/data/import/powo.jsonl` |
| 17 | `ipni.py` | International Plant Names Index | `plant_nomenclature` | Provider module / JSONL | dataset: `static/data/import/ipni.jsonl` |
| 18 | `tropicos.py` | Tropicos | `plant_taxonomy_nomenclature` | Provider module / JSONL | dataset: `static/data/import/tropicos.jsonl` |
| 19 | `grin_taxonomy.py` | GRIN Taxonomy | `plant_taxonomy_economic_botany` | Provider module / JSONL | dataset: `static/data/import/grin-taxonomy.jsonl` |
| 20 | `usda_plants.py` | USDA PLANTS | `regional_plant_taxonomy` | Provider module / JSONL | dataset: `static/data/import/usda-plants.jsonl` |
| 21 | `euro_med_plantbase.py` | Euro+Med PlantBase | `regional_plant_taxonomy` | Provider module / JSONL | dataset: `static/data/import/euro-med-plantbase.jsonl` |
| 22 | `zoobank.py` | ZooBank | `zoological_nomenclature` | Provider module / JSONL | dataset: `static/data/import/zoobank.jsonl` |
| 23 | `index_fungorum.py` | Index Fungorum | `fungal_taxonomy` | Provider module / JSONL | dataset: `static/data/import/index-fungorum.jsonl` |
| 24 | `mycobank.py` | MycoBank | `fungal_taxonomy` | Provider module / JSONL | dataset: `static/data/import/mycobank.jsonl` |
| 25 | `species_fungorum.py` | Species Fungorum | `fungal_checklist` | Provider module / JSONL | dataset: `static/data/import/species-fungorum.jsonl` |
| 26 | `irmng.py` | IRMNG | `taxonomy` | Provider module / JSONL | dataset: `static/data/import/irmng.jsonl` |
| 27 | `fishbase.py` | FishBase | `fish_taxonomy` | Provider module / JSONL | dataset: `static/data/import/fishbase.jsonl` |
| 28 | `sealifebase.py` | SeaLifeBase | `marine_taxonomy` | Provider module / JSONL | dataset: `static/data/import/sealifebase.jsonl` |
| 29 | `algaebase.py` | AlgaeBase | `algal_taxonomy` | Provider module / JSONL | dataset: `static/data/import/algaebase.jsonl` |
| 30 | `paleobiology.py` | Paleobiology Database | `paleontology` | Provider module / JSONL | dataset: `static/data/import/paleobiology.jsonl` |
| 31 | `bold.py` | Barcode of Life Data Systems | `genetic_barcodes` | Provider module / JSONL | dataset: `static/data/import/bold.jsonl` |
| 32 | `global_names.py` | Global Names | `name_reconciliation` | Provider module / JSONL | dataset: `static/data/import/global-names.jsonl` |
| 33 | `gnub.py` | Global Names Usage Bank | `taxonomic_name_usage` | Provider module / JSONL | dataset: `static/data/import/gnub.jsonl` |
| 34 | `obis.py` | OBIS | `marine_occurrence` | Provider module / JSONL | dataset: `static/data/import/obis.jsonl` |
| 35 | `ebird.py` | eBird / Clements | `bird_taxonomy_occurrence` | Provider module / JSONL | dataset: `static/data/import/ebird.jsonl` |
| 36 | `avibase.py` | Avibase | `bird_taxonomy` | Provider module / JSONL | dataset: `static/data/import/avibase.jsonl` |
| 37 | `ioc_world_bird_list.py` | IOC World Bird List | `bird_taxonomy` | Provider module / JSONL | dataset: `static/data/import/ioc-world-bird-list.jsonl` |
| 38 | `mammal_diversity_database.py` | Mammal Diversity Database | `mammal_taxonomy` | Provider module / JSONL | dataset: `static/data/import/mammal-diversity-database.jsonl` |
| 39 | `reptile_database.py` | The Reptile Database | `reptile_taxonomy` | Provider module / JSONL | dataset: `static/data/import/reptile-database.jsonl` |
| 40 | `amphibiaweb.py` | AmphibiaWeb | `amphibian_taxonomy` | Provider module / JSONL | dataset: `static/data/import/amphibiaweb.jsonl` |
| 41 | `amphibian_species_world.py` | Amphibian Species of the World | `amphibian_taxonomy` | Provider module / JSONL | dataset: `static/data/import/amphibian-species-world.jsonl` |
| 42 | `ala.py` | Atlas of Living Australia | `regional_occurrence` | Provider module / JSONL | dataset: `static/data/import/ala.jsonl` |
| 43 | `canadensys.py` | Canadensys | `regional_occurrence` | Provider module / JSONL | dataset: `static/data/import/canadensys.jsonl` |
| 44 | `idigbio.py` | iDigBio | `specimen_occurrence` | Provider module / JSONL | dataset: `static/data/import/idigbio.jsonl` |
| 45 | `natureserve.py` | NatureServe | `conservation` | Provider module / JSONL | credentials: NATURESERVE_API_KEY; dataset: `static/data/import/natureserve.jsonl` |
| 46 | `species_plus.py` | Species+ / CITES | `legal_conservation` | Provider module / JSONL | dataset: `static/data/import/species-plus.jsonl` |
| 47 | `cms_species.py` | CMS Species | `migratory_species_conservation` | Provider module / JSONL | dataset: `static/data/import/cms-species.jsonl` |
| 48 | `silva.py` | SILVA | `microbial_genetics` | Provider module / JSONL | dataset: `static/data/import/silva.jsonl` |
| 49 | `unite.py` | UNITE | `fungal_genetics` | Provider module / JSONL | dataset: `static/data/import/unite.jsonl` |
| 50 | `gtdb.py` | Genome Taxonomy Database | `prokaryotic_taxonomy` | Provider module / JSONL | dataset: `static/data/import/gtdb.jsonl` |
| 51 | `lpsn.py` | LPSN | `prokaryotic_nomenclature` | Provider module / JSONL | dataset: `static/data/import/lpsn.jsonl` |
| 52 | `bacdive.py` | BacDive | `prokaryotic_strains` | Provider module / JSONL | credentials: BACDIVE_USERNAME, BACDIVE_PASSWORD; dataset: `static/data/import/bacdive.jsonl` |
| 53 | `ictv.py` | ICTV | `viral_taxonomy` | Provider module / JSONL | dataset: `static/data/import/ictv.jsonl` |
| 54 | `viralzone.py` | ViralZone | `viral_enrichment` | Provider module / JSONL | dataset: `static/data/import/viralzone.jsonl` |
| 55 | `genbank.py` | GenBank | `genetic_sequences` | Provider module / JSONL | dataset: `static/data/import/genbank.jsonl` |
| 56 | `ena.py` | European Nucleotide Archive | `genetic_sequences` | Provider module / JSONL | dataset: `static/data/import/ena.jsonl` |
| 57 | `uniprot_taxonomy.py` | UniProt Taxonomy | `protein_taxonomy` | Provider module / JSONL | dataset: `static/data/import/uniprot-taxonomy.jsonl` |
| 58 | `antweb.py` | AntWeb | `ant_taxonomy` | Provider module / JSONL | dataset: `static/data/import/antweb.jsonl` |
| 59 | `antcat.py` | AntCat | `ant_nomenclature` | Provider module / JSONL | dataset: `static/data/import/antcat.jsonl` |
| 60 | `orthoptera_species_file.py` | Orthoptera Species File | `orthoptera_taxonomy` | Provider module / JSONL | dataset: `static/data/import/orthoptera-species-file.jsonl` |
| 61 | `odonata_central.py` | OdonataCentral | `odonata_taxonomy_occurrence` | Provider module / JSONL | dataset: `static/data/import/odonata-central.jsonl` |
| 62 | `world_spider_catalog.py` | World Spider Catalog | `arachnid_taxonomy` | Provider module / JSONL | dataset: `static/data/import/world-spider-catalog.jsonl` |
| 63 | `molluscabase.py` | MolluscaBase | `mollusc_taxonomy` | Provider module / JSONL | dataset: `static/data/import/molluscabase.jsonl` |
| 64 | `world_echinoderm_database.py` | World Echinoderm Database | `echinoderm_taxonomy` | Provider module / JSONL | dataset: `static/data/import/world-echinoderm-database.jsonl` |
| 65 | `bryozoa_net.py` | Bryozoa.net | `bryozoan_taxonomy` | Provider module / JSONL | dataset: `static/data/import/bryozoa-net.jsonl` |
| 66 | `fao_asfis.py` | FAO ASFIS | `fisheries_species_reference` | Provider module / JSONL | dataset: `static/data/import/fao-asfis.jsonl` |
| 67 | `plazi_treatmentbank.py` | Plazi TreatmentBank | `taxonomic_literature` | Provider module / JSONL | dataset: `static/data/import/plazi-treatmentbank.jsonl` |
| 68 | `biodiversity_heritage_library.py` | Biodiversity Heritage Library | `taxonomic_literature` | Provider module / JSONL | credentials: BHL_API_KEY; dataset: `static/data/import/biodiversity-heritage-library.jsonl` |
| 69 | `crossref.py` | Crossref | `bibliographic_enrichment` | Provider module / JSONL | dataset: `static/data/import/crossref.jsonl` |
| 70 | `openalex.py` | OpenAlex | `bibliographic_enrichment` | Provider module / JSONL | dataset: `static/data/import/openalex.jsonl` |
| 71 | `geonames.py` | GeoNames | `geographic_enrichment` | Provider module / JSONL | credentials: GEONAMES_USERNAME; dataset: `static/data/import/geonames.jsonl` |
| 72 | `marine_regions.py` | Marine Regions | `marine_geography` | Provider module / JSONL | dataset: `static/data/import/marine-regions.jsonl` |
| 73 | `wdpa.py` | World Database on Protected Areas | `protected_areas` | Provider module / JSONL | dataset: `static/data/import/wdpa.jsonl` |
| 74 | `key_biodiversity_areas.py` | Key Biodiversity Areas | `conservation_sites` | Provider module / JSONL | dataset: `static/data/import/key-biodiversity-areas.jsonl` |
| 75 | `darwin_core_archive.py` | Darwin Core Archive Import | `generic_taxonomy_occurrence_import` | Generic adapter | dataset: `static/data/import/dwca` |
| 76 | `generic_jsonl.py` | Generic JSONL Import | `generic_import` | Generic adapter | dataset: `static/data/import/generic-jsonl.jsonl` |
| 77 | `youtube.py` | YouTube | `media_reference_enrichment` | Direct API | credentials: YOUTUBE_API_KEY |

## Complete module inventory

```text
static/tools/providers/
├── __init__.py
├── common.py
├── loader.py
├── README.md
├── ala.py
├── algaebase.py
├── amphibiaweb.py
├── amphibian_species_world.py
├── antcat.py
├── antweb.py
├── avibase.py
├── bacdive.py
├── biodiversity_heritage_library.py
├── bold.py
├── bryozoa_net.py
├── canadensys.py
├── catalogue_of_life.py
├── cms_species.py
├── crossref.py
├── darwin_core_archive.py
├── ebird.py
├── ena.py
├── eol.py
├── euro_med_plantbase.py
├── fao_asfis.py
├── fishbase.py
├── gbif.py
├── generic_jsonl.py
├── genbank.py
├── geonames.py
├── global_names.py
├── gnub.py
├── grin_taxonomy.py
├── gtdb.py
├── ictv.py
├── idigbio.py
├── inaturalist.py
├── index_fungorum.py
├── ioc_world_bird_list.py
├── ipni.py
├── irmng.py
├── itis.py
├── iucn_green_list.py
├── iucn_green_status.py
├── iucn_red_list.py
├── key_biodiversity_areas.py
├── lpsn.py
├── mammal_diversity_database.py
├── marine_regions.py
├── molluscabase.py
├── mycobank.py
├── natureserve.py
├── ncbi_taxonomy.py
├── obis.py
├── odonata_central.py
├── open_tree_of_life.py
├── openalex.py
├── orthoptera_species_file.py
├── paleobiology.py
├── plazi_treatmentbank.py
├── powo.py
├── reptile_database.py
├── sealifebase.py
├── silva.py
├── species_fungorum.py
├── species_plus.py
├── tropicos.py
├── uniprot_taxonomy.py
├── unite.py
├── usda_plants.py
├── viralzone.py
├── wdpa.py
├── wikidata.py
├── wikipedia.py
├── wikispecies.py
├── world_echinoderm_database.py
├── world_flora_online.py
├── world_spider_catalog.py
├── worms.py
├── youtube.py
└── zoobank.py
```

## Project policy

All providers remain enabled in the registry unless they are intentionally
retired, legally prohibited, superseded, or placed into explicit maintenance
mode. Missing datasets, credentials, dependencies, and temporary provider
failures are runtime eligibility conditions, not reasons to remove a provider
from the Speciedex ecosystem.
