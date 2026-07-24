# Speciedex Reports

This directory contains report generators for provider, taxonomy, archive,
database, icon, statistics, and publication health.

`daily.py` is the current generator. It should summarize provider outcomes,
accepted/rejected records, additions, revisions, conflicts, database shard
totals and parity, icon verification, statistics changes, and release-blocking
errors. Future weekly and monthly reports should aggregate the same canonical
metrics.

Reports should read manifests and structured state, not scrape prose logs, and
must never expose credentials or private provider payloads.
