from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class StaticAPIBuilder:
    def __init__(self, server: Any) -> None:
        self.server = server

    def _write(self, relative: str, payload: Any) -> Path:
        path = self.server.config.static_api_root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor,temporary=tempfile.mkstemp(dir=path.parent,prefix='.'+path.name)
        try:
            with os.fdopen(descriptor,'w',encoding='utf-8') as output:
                output.write(json.dumps(payload,indent=2,sort_keys=True,default=str)+'\n');output.flush();os.fsync(output.fileno())
            os.chmod(temporary,0o644);os.replace(temporary,path)
        finally:
            if os.path.exists(temporary):os.unlink(temporary)
        return path

    def build(self) -> dict[str, Any]:
        generated = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "files": [],
        }
        endpoints = {
            "health.json": self.server.health_payload(),
            "stats.json": self.server.stats.collect(),
            "stream.json": {"records": [json.loads(chunk.split('data: ',1)[1]) for chunk in self.server.stream.iter_records(limit=128,paced=False) if chunk.startswith('data: ')]},
            "providers.json": self.server.providers.list(),
            "routes.json": self.server.routes_payload(),
            "providers/enabled.json": self.server.providers.enabled(),
            "providers/eligible.json": self.server.providers.eligible(),
            "providers/assertions.json": self.server.providers.assertions(),
            "providers/documentation.json": self.server.providers.documentation(),
            "providers/errors.json": self.server.providers.errors(),
            "providers/latency.json": self.server.providers.latency(),
            "providers/overlap.json": self.server.providers.overlap(),
            "providers/statistics.json": self.server.providers.statistics(),
        }
        for relative, payload in endpoints.items():
            path = self._write(relative, payload)
            generated["files"].append(path.relative_to(self.server.config.repo_root).as_posix())
        index = self._write("index.json", generated)
        generated["index"] = index.relative_to(self.server.config.repo_root).as_posix()
        return generated
