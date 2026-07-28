"""Extension point for the storage endpoint."""
from __future__ import annotations
from typing import Any


def register(router: Any, services: Any) -> None:
    """Register project-specific storage routes when needed."""
    return None
