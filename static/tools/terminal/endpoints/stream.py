"""Extension point for the stream endpoint."""
from __future__ import annotations
from typing import Any


def register(router: Any, services: Any) -> None:
    """Register project-specific stream routes when needed."""
    return None
