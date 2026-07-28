from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Any


@dataclass
class HealthReport:
    ok: bool
    checks: dict[str, Any]
    version: str = "1.0.0"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, sort_keys=True)


@dataclass
class APIResponse:
    status: int
    payload: Any
    headers: dict[str, str] | None = None
