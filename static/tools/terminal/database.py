from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        if not self.path.exists():
            raise FileNotFoundError(f"SQLite database not found: {self.path}")
        connection = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, timeout=30)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
        finally:
            connection.close()

    def tables(self) -> list[str]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            ).fetchall()
        return [str(row["name"]) for row in rows]

    def find_taxon_table(self) -> str | None:
        candidates = ("taxa", "taxonomy", "records", "species", "taxon")
        tables = set(self.tables())
        return next((name for name in candidates if name in tables), None)

    def columns(self, table: str) -> list[str]:
        if not table.replace("_", "").isalnum():
            raise ValueError("Unsafe table name")
        with self.connect() as connection:
            return [str(row["name"]) for row in connection.execute(f"PRAGMA table_info({table})")]

    def query(self, sql: str, parameters: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        with self.connect() as connection:
            return [dict(row) for row in connection.execute(sql, parameters).fetchall()]
