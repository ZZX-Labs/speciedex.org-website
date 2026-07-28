from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class ProviderService:
    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root

    def _candidates(self) -> list[Path]:
        return [
            self.repo_root / "static/tools/providers.json",
            self.repo_root / "static/data/providers.json",
            self.repo_root / "static/tools/providers/providers.json",
        ]

    def list(self) -> dict[str, Any]:
        for path in self._candidates():
            if path.exists():
                data = json.loads(path.read_text(encoding="utf-8"))
                providers = data.get("providers", data) if isinstance(data, dict) else data
                return {"source": str(path), "count": len(providers), "providers": providers}
        docs = self.repo_root / "static/tools/documentation"
        entries = []
        if docs.exists():
            for path in sorted(docs.glob("*.json")):
                try:
                    entries.append(json.loads(path.read_text(encoding="utf-8")))
                except Exception:
                    entries.append({"name": path.stem, "error": "invalid JSON"})
        return {"source": str(docs), "count": len(entries), "providers": entries}
