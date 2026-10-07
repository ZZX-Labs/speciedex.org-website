from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable

from .models import APIResponse

Handler = Callable[[dict[str, list[str]], bytes], APIResponse]


@dataclass
class Route:
    method: str
    path: str
    handler: Handler


class Router:
    def __init__(self) -> None:
        self.routes: dict[tuple[str, str], Handler] = {}
        self.dynamic_routes: list[tuple[str, str, re.Pattern[str], Handler]] = []

    def add(self, method: str, path: str, handler: Handler) -> None:
        method = method.upper()
        normalized = path.rstrip("/") or "/"
        self.routes[(method, normalized)] = handler
        if "{" in normalized and "}" in normalized:
            pattern = re.sub(
                r"\{([A-Za-z_][A-Za-z0-9_]*)\}",
                r"(?P<\1>[^/]+)",
                normalized,
            )
            self.dynamic_routes.append((method, normalized, re.compile(f"^{pattern}$"), handler))

    def dispatch(self, method: str, path: str, query: dict[str, list[str]], body: bytes) -> APIResponse:
        normalized = path.rstrip("/") or "/"
        method = method.upper()
        if normalized.endswith('.json') and (method,normalized) not in self.routes:normalized=normalized[:-5]
        handler = self.routes.get((method, normalized))
        if handler:
            return handler(query, body)
        for route_method, _route_path, pattern, dynamic_handler in self.dynamic_routes:
            if route_method != method:
                continue
            match = pattern.match(normalized)
            if not match:
                continue
            augmented = {key: list(value) for key, value in query.items()}
            for key, value in match.groupdict().items():
                augmented[f"__{key}"] = [value]
            return dynamic_handler(augmented, body)
        return APIResponse(404, {"error": "not_found", "path": path})
