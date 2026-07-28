from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from .database import Database


class StatsService:
    def __init__(self, database: Database, taxonomy_root: Path) -> None:
        self.database = database
        self.taxonomy_root = taxonomy_root

    def collect(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "database": str(self.database.path),
            "database_exists": self.database.path.exists(),
            "taxonomy_root": str(self.taxonomy_root),
            "taxonomy_exists": self.taxonomy_root.exists(),
        }

        if self.database.path.exists():
            try:
                result["tables"] = self.database.tables()
                table = self.database.find_taxon_table()
                if table:
                    result["records"] = self.database.query(f"SELECT COUNT(*) AS count FROM {table}")[0]["count"]
                    columns = self.database.columns(table)
                    if "rank" in columns:
                        result["ranks"] = self.database.query(
                            f"SELECT rank, COUNT(*) AS count FROM {table} GROUP BY rank ORDER BY count DESC"
                        )
                    if "provider" in columns:
                        result["providers"] = self.database.query(
                            f"SELECT provider, COUNT(*) AS count FROM {table} GROUP BY provider ORDER BY count DESC"
                        )
            except Exception as error:
                result["database_error"] = str(error)

        manifest = self.taxonomy_root / "manifest.json"
        if manifest.exists():
            try:
                result["manifest"] = json.loads(manifest.read_text(encoding="utf-8"))
            except Exception as error:
                result["manifest_error"] = str(error)

        return result
