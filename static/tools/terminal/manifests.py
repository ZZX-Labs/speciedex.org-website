from __future__ import annotations

import hashlib
import json
import os
import tempfile
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

    def build(self, roots: list[Path], exclude: Path | None = None) -> dict[str, Any]:
        files: list[dict[str, Any]] = []
        for root in roots:
            if not root.exists():
                continue
            for path in sorted(p for p in root.rglob("*") if p.is_file()):
                if path == exclude or path.name == "SHA256SUMS" or path.name.startswith(".") or path.suffix in {".log", ".lock"}:continue
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
        payload = self.build(roots,exclude=output)
        self._write_text(output, json.dumps(payload, indent=2, sort_keys=True) + "\n")
        return payload

    @staticmethod
    def _write_text(output: Path, text: str) -> None:
        output.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(dir=output.parent, prefix="." + output.name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o644)
            os.replace(temporary, output)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def write_checksums(self, root: Path) -> Path:
        output = root / "SHA256SUMS"
        files = sorted(path for path in root.rglob("*")
                       if path.is_file() and path != output and not path.name.startswith("."))
        self._write_text(output, "".join(
            f"{sha256_file(path)}  {path.relative_to(self.repo_root).as_posix()}\n"
            for path in files
        ))
        return output
