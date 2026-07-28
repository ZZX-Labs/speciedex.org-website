from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class APIConfig:
    repo_root: Path
    host: str = "127.0.0.1"
    port: int = 8765
    api_prefix: str = "/api/speciedex/v1"
    log_level: str = "INFO"
    cors_origins: list[str] = field(default_factory=lambda: ["*"])
    sqlite_path: Path | None = None
    taxonomy_root: Path | None = None
    static_api_root: Path | None = None
    runtime_dir: Path | None = None
    max_results: int = 500
    stream_interval_ms: int = 250
    rate_limit_per_minute: int = 600

    def __post_init__(self) -> None:
        self.repo_root = self.repo_root.resolve()
        self.sqlite_path = (self.sqlite_path or self.repo_root / "static/data/taxonomy/index.sqlite3").resolve()
        self.taxonomy_root = (self.taxonomy_root or self.repo_root / "static/data/taxonomy").resolve()
        self.static_api_root = (self.static_api_root or self.repo_root / "api/speciedex/v1").resolve()
        self.runtime_dir = (self.runtime_dir or self.repo_root / ".runtime/terminal-api").resolve()
        self.runtime_dir.mkdir(parents=True, exist_ok=True)

    @classmethod
    def load(
        cls,
        config_path: Path | None = None,
        repo_root: Path | None = None,
        overrides: dict[str, Any] | None = None,
    ) -> "APIConfig":
        root = (repo_root or Path(__file__).resolve().parents[3]).resolve()
        data: dict[str, Any] = {}

        default_path = root / "static/tools/terminal-api.json"
        path = config_path or default_path
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))

        data["repo_root"] = Path(data.get("repo_root") or root)
        for key in ("sqlite_path", "taxonomy_root", "static_api_root", "runtime_dir"):
            if data.get(key):
                candidate = Path(data[key])
                data[key] = candidate if candidate.is_absolute() else root / candidate

        env_map = {
            "host": "SPECIEDEX_API_HOST",
            "port": "SPECIEDEX_API_PORT",
            "log_level": "SPECIEDEX_API_LOG_LEVEL",
        }
        for key, env_name in env_map.items():
            if os.getenv(env_name):
                data[key] = int(os.environ[env_name]) if key == "port" else os.environ[env_name]

        for key, value in (overrides or {}).items():
            if value is not None:
                data[key] = value

        return cls(**data)
