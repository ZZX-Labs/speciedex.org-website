"""Extension point for the state endpoint."""
from __future__ import annotations
from typing import Any


def register(router: Any, services: Any) -> None:
    """Register project-specific state routes when needed."""
    return None
