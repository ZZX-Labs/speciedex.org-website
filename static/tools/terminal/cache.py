from __future__ import annotations

import threading
import time
from collections import OrderedDict
from typing import Any


class TTLCache:
    def __init__(self, limit: int = 512, ttl: float = 30.0) -> None:
        self.limit = max(1, limit)
        self.ttl = max(0.0, ttl)
        self._lock = threading.RLock()
        self._items: OrderedDict[str, tuple[float, Any]] = OrderedDict()

    def get(self, key: str) -> Any | None:
        with self._lock:
            item = self._items.get(key)
            if not item:
                return None
            expires, value = item
            if expires and time.time() >= expires:
                self._items.pop(key, None)
                return None
            self._items.move_to_end(key)
            return value

    def set(self, key: str, value: Any, ttl: float | None = None) -> None:
        with self._lock:
            duration = self.ttl if ttl is None else max(0.0, ttl)
            expires = time.time() + duration if duration else 0.0
            self._items[key] = (expires, value)
            self._items.move_to_end(key)
            while len(self._items) > self.limit:
                self._items.popitem(last=False)

    def clear(self) -> int:
        with self._lock:
            count = len(self._items)
            self._items.clear()
            return count

    def stats(self) -> dict[str, int | float]:
        with self._lock:
            return {"entries": len(self._items), "limit": self.limit, "ttl": self.ttl}
