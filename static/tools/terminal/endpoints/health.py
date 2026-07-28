"""Extension point for the health endpoint."""
from __future__ import annotations
from typing import Any


def register(router: Any, services: Any) -> None:
    """Register project-specific health routes when needed."""
    return None
