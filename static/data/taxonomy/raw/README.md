# Raw Taxonomy Inputs

This directory stores provider records after retrieval and before canonical normalization. Raw files preserve the provider payload closely enough to support reproducible normalization, debugging, licensing review, and later reprocessing.

## Current contents

- `test-taxa.json` — small development fixture used to exercise the taxonomy and icon/database pipelines.

Production provider downloads may be organized by provider and retrieval batch, for example:

```text
raw/
├── gbif/
│   └── 2026-07-24.jsonl
├── worms/
│   └── 2026-07-24.jsonl
└── inaturalist/
    └── 2026-07-24.jsonl
```

## Rules

- Do not manually convert raw provider fields into the Speciedex schema here.
- Preserve provider identifiers, source URLs, timestamps, licensing metadata, and response metadata.
- Never store credentials, tokens, usernames, cookies, or private request headers.
- Large provider payloads should be segmented below the repository file-size limit.
- JSON, JSONL, and NDJSON are the supported canonical interchange formats for the Python tools.
- A raw record may be invalid; invalidity is handled by normalization and rejection stages.

## Consumers

Raw files are consumed by the tools under:

- `static/tools/providers/`
- `static/tools/icon-forge/normalize-taxonomy.py`
- `static/tools/database/common.py`
- provider-specific tests and schemas

## Output path

```text
raw provider records
    ↓ normalize and validate
static/data/taxonomy/normalized/
    ├── canonical records
    └── icon queue

invalid records
    ↓
static/data/taxonomy/rejected/
```
