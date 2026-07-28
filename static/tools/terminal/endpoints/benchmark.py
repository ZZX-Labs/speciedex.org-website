"""Extension point for the benchmark endpoint."""
from __future__ import annotations
from typing import Any


def register(router: Any, services: Any) -> None:
    """Register project-specific benchmark routes when needed."""
    return None
