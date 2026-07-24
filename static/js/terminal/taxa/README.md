# SpeciedexTerminal Taxonomic Modules

This directory provides rank-specific terminal services and commands for searching the canonical Speciedex taxonomy. Every module normalizes query parameters and API/database responses for one rank or rank family.

The modules are consumers of the published database layer. They must not read provider source files directly or alter taxonomy records.

## Files and command families

| File | Rank coverage | Primary command family |
|---|---|---|
| `terminal-domains.js` | domain | `domains`, `domain`, children, lineage, synonyms, summary, status |
| `terminal-kingdoms.js` | kingdom | `kingdoms`, `kingdom`, by-domain, children, lineage, synonyms, summary, status |
| `terminal-phyla.js` | phylum | `phyla`, `phylum`, by-kingdom, children, lineage, synonyms, summary, status |
| `terminal-classes.js` | class | `classes`, `class`, by-phylum, children, lineage, synonyms, summary, status |
| `terminal-orders.js` | order | `orders`, `order`, by-class, children, lineage, synonyms, summary, status |
| `terminal-families.js` | superfamily/family/subfamily | `families`, `family`, by-order, children, lineage, synonyms, summary, status |
| `terminal-tribes.js` | tribe | `tribes`, `tribe`, by-family/by-genus, children, lineage, synonyms, summary, status |
| `terminal-genera.js` | genus | `genera`, `genus`, by-family, children, lineage, synonyms, summary, status |
| `terminal-species.js` | species | `species`, `species-get`, accepted/synonym/threatened/extinct/endemic/invasive filters, lineage, summary, status |
| `terminal-subspecies.js` | subspecies | `subspecies`, lookup, by-species, lineage, synonyms, summary, status |
| `terminal-varieties.js` | variety | `varieties`, lookup, by-species/by-subspecies, lineage, synonyms, summary, status |
| `terminal-forms.js` | form | `forms`, lookup, lineage, synonyms, summary, status |
| `terminal-clades.js` | clade and unranked clades | `clades`, lookup, children, descendants, hierarchy, lineage, synonyms, summary, status |
| `terminal-ranks.js` | rank metadata | `ranks`, `rank`, supported/major/hierarchy/lineage/children/compare/summary/status |

## Canonical response expectations

Rank services should expose normalized records containing, where available:

- `speciedex_id` or stable `id`;
- `scientific_name` and `canonical_name`;
- `common_name`;
- `rank` and `status`;
- accepted-name and synonym relationships;
- parent/child identifiers;
- lineage fields;
- provider/source information;
- descendant counts;
- `created_at`, `updated_at`, or `indexed_at`.

## Search path

```text
terminal command
    ↓
rank service in this directory
    ↓
static/js/data.js database broker
    ↓
search/index worker
    ↓
SQLite shard selected through static/data/db/indexes/
    ↓
normalized result returned to terminal renderer
```

MariaDB logical shards exist for server import, replication, and parity verification. Browser searches should use SQLite/WebAssembly and lightweight indexes.

## Current integration note

`terminal-families.js` includes its own lifecycle event helper and detailed family normalization. The remaining rank modules must be audited against the same service, event, validation, and teardown contract so all rank commands behave uniformly.

## Validation requirements

```bash
node --check static/js/terminal/taxa/*.js
python static/tools/database/verify-shards.py
python static/tools/database/verify-database-parity.py
```

Search results and summary totals must be consistent across rank modules, the database manifests, and the splash/statistics counters.
