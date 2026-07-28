"""Extension point for the archive endpoint."""
from __future__ import annotations
from typing import Any


def register(router: Any, services: Any) -> None:
    """Register project-specific archive routes when needed."""
    return None
