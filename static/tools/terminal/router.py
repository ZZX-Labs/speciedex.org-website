from __future__ import annotations

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

    def add(self, method: str, path: str, handler: Handler) -> None:
        self.routes[(method.upper(), path.rstrip("/") or "/")] = handler

    def dispatch(self, method: str, path: str, query: dict[str, list[str]], body: bytes) -> APIResponse:
        normalized = path.rstrip("/") or "/"
        handler = self.routes.get((method.upper(), normalized))
        if not handler:
            return APIResponse(404, {"error": "not_found", "path": path})
        return handler(query, body)
