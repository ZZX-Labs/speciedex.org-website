from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class StaticAPIBuilder:
    def __init__(self, server: Any) -> None:
        self.server = server

    def _write(self, relative: str, payload: Any) -> Path:
        path = self.server.config.static_api_root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
        return path

    def build(self) -> dict[str, Any]:
        generated = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "files": [],
        }
        endpoints = {
            "health.json": self.server.health_payload(),
            "stats.json": self.server.stats.collect(),
            "providers.json": self.server.providers.list(),
            "routes.json": self.server.routes_payload(),
        }
        for relative, payload in endpoints.items():
            path = self._write(relative, payload)
            generated["files"].append(str(path))
        index = self._write("index.json", generated)
        generated["index"] = str(index)
        return generated
