from __future__ import annotations

import sqlite3
import json
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path

    def paths(self) -> list[Path]:
        if not self.path.is_dir():return [self.path] if self.path.is_file() else []
        manifest=json.loads((self.path/'manifest.json').read_text(encoding='utf-8'))
        paths=[]
        for entry in manifest.get('shards',[]):
            path=(self.path/(entry.get('filename') or entry.get('file') or entry.get('path') or '')).resolve()
            if not path.is_relative_to(self.path.resolve()) or not path.is_file():raise ValueError('Invalid SQLite shard')
            paths.append(path)
        return paths

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        if not self.path.exists():
            raise FileNotFoundError(f"SQLite database not found: {self.path}")
        paths=self.paths()
        if not paths:raise FileNotFoundError('No SQLite shards available')
        if len(paths)>10:raise sqlite3.OperationalError('Use canonical archive search for more than 10 shards')
        connection = sqlite3.connect(paths[0].as_uri()+'?mode=ro', uri=True, timeout=30) if len(paths)==1 else sqlite3.connect(':memory:',uri=True)
        connection.row_factory = sqlite3.Row
        try:
            if len(paths)>1:
                tables=None
                for index,path in enumerate(paths):
                    connection.execute(f'ATTACH DATABASE ? AS shard{index}',(path.as_uri()+'?mode=ro',))
                    names={row[0] for row in connection.execute(f"SELECT name FROM shard{index}.sqlite_master WHERE type='table'") if str(row[0]).replace('_','').isalnum()}
                    tables=names if tables is None else tables & names
                for table in tables or []:
                    connection.execute(f'CREATE TEMP VIEW "{table}" AS '+ ' UNION ALL '.join(f'SELECT * FROM shard{index}."{table}"' for index in range(len(paths))))
            yield connection
        finally:
            connection.close()

    def tables(self) -> list[str]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' UNION SELECT name FROM sqlite_temp_master WHERE type='view' ORDER BY name"
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
