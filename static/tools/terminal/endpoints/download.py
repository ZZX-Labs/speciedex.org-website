"""Extension point for the download endpoint."""
from __future__ import annotations
from typing import Any


def register(router: Any, services: Any) -> None:
    """Register project-specific download routes when needed."""
    return None
