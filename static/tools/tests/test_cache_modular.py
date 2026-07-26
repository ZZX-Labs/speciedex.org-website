
from __future__ import annotations

import tempfile
import time
from pathlib import Path

from static.tools.core.cache import (
    CacheManager,
    CachePolicy,
    MemoryLRUCache,
    create_cache_bundle,
    cache_key,
)


def test_public_wrapper_and_memory_cache() -> None:
    cache = MemoryLRUCache(maximum_entries=2, maximum_bytes=1024 * 1024)
    policy = CachePolicy(ttl_seconds=60, disk=False)
    with tempfile.TemporaryDirectory() as directory:
        manager = CacheManager(
            Path(directory),
            default_policy=policy,
            auto_prune=False,
        )
        assert manager.set("alpha", {"value": 1}, policy=policy)
        assert manager.get("alpha", policy=policy) == {"value": 1}


def test_disk_round_trip() -> None:
    with tempfile.TemporaryDirectory() as directory:
        policy = CachePolicy(ttl_seconds=60, memory=True, disk=True)
        manager = CacheManager(Path(directory), default_policy=policy, auto_prune=False)
        assert manager.set({"k": 1}, [1, 2, 3], namespace="test", policy=policy)
        manager.memory.clear()
        assert manager.get({"k": 1}, namespace="test", policy=policy) == [1, 2, 3]
        assert manager.verify().valid


def test_bundle_facades() -> None:
    with tempfile.TemporaryDirectory() as directory:
        bundle = create_cache_bundle(Path(directory), auto_prune=False)
        assert bundle.statistics.set(name="species", value={"count": 5})
        assert bundle.statistics.get(name="species") == {"count": 5}
        bundle.close()


def test_key_is_deterministic() -> None:
    assert cache_key({"b": 2, "a": 1}) == cache_key({"a": 1, "b": 2})
