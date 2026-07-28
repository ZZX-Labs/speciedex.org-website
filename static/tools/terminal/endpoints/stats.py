"""Extension point for the stats endpoint."""
from __future__ import annotations
from typing import Any


def register(router: Any, services: Any) -> None:
    """Register project-specific stats routes when needed."""
    return None
