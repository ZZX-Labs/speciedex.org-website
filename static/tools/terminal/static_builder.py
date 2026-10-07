from __future__ import annotations

import hashlib
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

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _write_assertion_volumes(
        self,
        payload: Any,
        volume_count: int = 4,
    ) -> list[Path]:
        if not isinstance(payload, dict):
            raise TypeError("Provider assertions payload must be a JSON object.")

        records = payload.get("records")
        assertions = payload.get("assertions")

        if isinstance(records, list) and isinstance(assertions, list):
            if records != assertions:
                raise ValueError(
                    "Provider assertions payload has divergent records/assertions arrays."
                )
            source = records
        elif isinstance(records, list):
            source = records
        elif isinstance(assertions, list):
            source = assertions
        else:
            raise TypeError(
                "Provider assertions payload must contain records or assertions arrays."
            )

        if volume_count < 1:
            raise ValueError("volume_count must be at least 1.")

        count = len(source)
        quotient, remainder = divmod(count, volume_count)
        base_offset = int(payload.get("offset", 0) or 0)
        total = int(payload.get("total", count) or count)

        volume_paths: list[Path] = []
        volume_entries: list[dict[str, Any]] = []
        cursor = 0

        for index in range(volume_count):
            length = quotient + (1 if index < remainder else 0)
            chunk = source[cursor:cursor + length]
            volume_number = index + 1
            filename = f"assertions-{volume_number:04d}.json"
            relative = f"providers/{filename}"

            volume_payload = {
                "assertions": chunk,
                "count": len(chunk),
                "limit": len(chunk),
                "offset": base_offset + cursor,
                "records": chunk,
                "total": total,
                "volume": volume_number,
                "volume_count": volume_count,
            }

            path = self._write(relative, volume_payload)
            volume_paths.append(path)
            volume_entries.append({
                "volume": volume_number,
                "file": filename,
                "path": relative,
                "count": len(chunk),
                "limit": len(chunk),
                "offset": base_offset + cursor,
                "size": path.stat().st_size,
                "sha256": self._sha256(path),
            })
            cursor += length

        wrapper = {
            key: value
            for key, value in payload.items()
            if key not in {"records", "assertions"}
        }
        wrapper.update({
            "schema": "speciedex-provider-assertions-volume-index-v1",
            "sharded": True,
            "volume_count": volume_count,
            "volumes": volume_entries,
        })

        wrapper_path = self._write("providers/assertions.json", wrapper)
        return [wrapper_path, *volume_paths]

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
            if relative == "providers/assertions.json":
                paths = self._write_assertion_volumes(payload, volume_count=4)
                generated["files"].extend(
                    path.relative_to(self.server.config.repo_root).as_posix()
                    for path in paths
                )
                continue

            path = self._write(relative, payload)
            generated["files"].append(path.relative_to(self.server.config.repo_root).as_posix())
        index = self._write("index.json", generated)
        generated["index"] = index.relative_to(self.server.config.repo_root).as_posix()
        return generated
