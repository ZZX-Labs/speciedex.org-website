# Speciedex Database Tools

`static/data/taxonomy/` is the canonical source. Every derived product is
rebuilt from it so SQLite and MariaDB remain uniform.

Build everything:

```bash
python static/tools/database/build-databases.py
```

Verify:

```bash
python static/tools/database/verify-shards.py
python static/tools/database/verify-database-parity.py
```

Importing a database does not directly overwrite the other format. Import
into taxonomy JSONL, reconcile, then rebuild both formats together.
