from __future__ import annotations

from typing import Any
from .database import Database


class SearchService:
    def __init__(self, database: Database, max_results: int = 500) -> None:
        self.database = database
        self.max_results = max(1, max_results)

    def search(self, query: str, limit: int = 100, offset: int = 0) -> dict[str, Any]:
        query = query.strip()
        limit = min(self.max_results, max(1, int(limit)))
        offset = max(0, int(offset))
        if not query:
            return {"query": query, "count": 0, "records": []}

        table = self.database.find_taxon_table()
        if not table:
            return {"query": query, "count": 0, "records": [], "warning": "No taxon table found"}

        columns = self.database.columns(table)
        searchable = [
            name for name in (
                "scientific_name", "canonical_name", "name", "common_name",
                "vernacular_name", "speciedex_id", "id", "provider"
            )
            if name in columns
        ]
        if not searchable:
            searchable = columns[:3]

        where = " OR ".join(f"CAST({column} AS TEXT) LIKE ?" for column in searchable)
        parameters = tuple([f"%{query}%"] * len(searchable) + [limit, offset])
        sql = f"SELECT * FROM {table} WHERE {where} LIMIT ? OFFSET ?"
        records = self.database.query(sql, parameters)
        return {"query": query, "count": len(records), "limit": limit, "offset": offset, "records": records}
