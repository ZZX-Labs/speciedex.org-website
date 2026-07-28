from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class ManifestService:
    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root

    def build(self, roots: list[Path]) -> dict[str, Any]:
        files: list[dict[str, Any]] = []
        for root in roots:
            if not root.exists():
                continue
            for path in sorted(p for p in root.rglob("*") if p.is_file()):
                files.append({
                    "path": path.relative_to(self.repo_root).as_posix(),
                    "size": path.stat().st_size,
                    "sha256": sha256_file(path),
                })
        return {
            "schema": "speciedex-terminal-api-manifest",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "count": len(files),
            "files": files,
        }

    def write(self, output: Path, roots: list[Path]) -> dict[str, Any]:
        payload = self.build(roots)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return payload
