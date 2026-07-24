# Speciedex Database Products

This directory is generated from `static/data/taxonomy/`.

- `sqlite/`: browser-queryable SQLite shards
- `mariadb/`: compressed MariaDB-compatible logical shards
- `indexes/`: lightweight browser routing/search indexes
- `updates/`: incremental additions, changes, and deletions
- `reports/`: verification and parity reports

Never manually edit one database format and publish it alone. Import the
change into taxonomy, reconcile it, and rebuild SQLite and MariaDB together.
