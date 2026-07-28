"""Extension point for the search endpoint."""
from __future__ import annotations
from typing import Any


def register(router: Any, services: Any) -> None:
    """Register project-specific search routes when needed."""
    return None
