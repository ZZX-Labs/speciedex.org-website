#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/cache_memory.py

Thread-safe memory LRU storage and filesystem entry locking.

This module is an internal component of the public cache.py compatibility
wrapper. Import public cache APIs from static.tools.core.cache.

Copyright (c) 2026 ZZX-Laboratories
Licensed under the MIT License.
"""

from __future__ import annotations

try:
    from .cache_common import *
except ImportError:  # Direct-module compatibility.
    from cache_common import *

class MemoryLRUCache(Generic[ValueType]):
    """
    Thread-safe in-memory LRU cache with entry and byte limits.
    """

    def __init__(
        self,
        *,
        maximum_entries: int = (
            DEFAULT_MEMORY_MAX_ENTRIES
        ),
        maximum_bytes: int = (
            DEFAULT_MEMORY_MAX_BYTES
        ),
        statistics: CacheStatistics | None = None,
    ) -> None:
        self.maximum_entries = max(
            0,
            int(maximum_entries),
        )

        self.maximum_bytes = max(
            0,
            int(maximum_bytes),
        )

        self.statistics = (
            statistics
            if statistics is not None
            else CacheStatistics()
        )

        self._items: OrderedDict[
            tuple[str, str],
            MemoryCacheItem[ValueType],
        ] = OrderedDict()

        self._bytes = 0
        self._lock = threading.RLock()

    def __len__(self) -> int:
        with self._lock:
            return len(
                self._items
            )

    @property
    def size_bytes(self) -> int:
        """Return estimated in-memory cache size."""

        with self._lock:
            return self._bytes

    def get(
        self,
        namespace: str,
        key_hash_value: str,
        *,
        allow_stale: bool = False,
        refresh_on_access: bool = True,
    ) -> CacheEntry[ValueType] | None:
        """Read one in-memory entry."""

        cache_identity = (
            normalize_namespace(
                namespace
            ),
            normalize_key(
                key_hash_value
            ),
        )

        with self._lock:
            item = self._items.get(
                cache_identity
            )

            if item is None:
                self.statistics.memory_misses += 1
                return None

            if item.metadata.dead:
                self._delete_unlocked(
                    cache_identity
                )

                self.statistics.memory_misses += 1
                self.statistics.expirations += 1

                return None

            if (
                item.metadata.expired
                and not allow_stale
            ):
                self.statistics.memory_misses += 1
                return None

            if refresh_on_access:
                item.metadata.touch()

            self._items.move_to_end(
                cache_identity
            )

            self.statistics.memory_hits += 1

            if item.metadata.expired:
                self.statistics.stale_hits += 1

            return CacheEntry(
                value=item.value,
                metadata=item.metadata,
                layer="memory",
            )

    def set(
        self,
        namespace: str,
        key_hash_value: str,
        value: ValueType,
        metadata: CacheEntryMetadata,
    ) -> None:
        """Store one in-memory entry."""

        if (
            self.maximum_entries == 0
            or self.maximum_bytes == 0
        ):
            return

        cache_identity = (
            normalize_namespace(
                namespace
            ),
            normalize_key(
                key_hash_value
            ),
        )

        estimated_bytes = (
            estimate_size_bytes(value)
            + estimate_size_bytes(
                metadata.to_dict()
            )
        )

        with self._lock:
            existing = self._items.pop(
                cache_identity,
                None,
            )

            if existing is not None:
                self._bytes -= (
                    existing.estimated_bytes
                )

            self._items[
                cache_identity
            ] = MemoryCacheItem(
                value=value,
                metadata=metadata,
                estimated_bytes=(
                    estimated_bytes
                ),
            )

            self._bytes += estimated_bytes

            self._evict_unlocked()

    def delete(
        self,
        namespace: str,
        key_hash_value: str,
    ) -> bool:
        """Delete one in-memory entry."""

        cache_identity = (
            normalize_namespace(
                namespace
            ),
            normalize_key(
                key_hash_value
            ),
        )

        with self._lock:
            return self._delete_unlocked(
                cache_identity
            )

    def clear(
        self,
        *,
        namespace: str | None = None,
    ) -> int:
        """Clear all entries or one namespace."""

        with self._lock:
            if namespace is None:
                count = len(
                    self._items
                )

                self._items.clear()
                self._bytes = 0

                return count

            normalized_namespace = (
                normalize_namespace(
                    namespace
                )
            )

            identities = [
                identity
                for identity
                in self._items
                if identity[0]
                == normalized_namespace
            ]

            for identity in identities:
                self._delete_unlocked(
                    identity
                )

            return len(identities)

    def prune(self) -> int:
        """Remove expired entries."""

        removed = 0

        with self._lock:
            for identity in list(
                self._items
            ):
                item = self._items[
                    identity
                ]

                if item.metadata.dead:
                    self._delete_unlocked(
                        identity
                    )

                    self.statistics.expirations += 1
                    removed += 1

        return removed

    def keys(
        self,
        *,
        namespace: str | None = None,
    ) -> list[tuple[str, str]]:
        """Return cached namespace/hash identities."""

        with self._lock:
            if namespace is None:
                return list(
                    self._items.keys()
                )

            normalized_namespace = (
                normalize_namespace(
                    namespace
                )
            )

            return [
                identity
                for identity
                in self._items.keys()
                if identity[0]
                == normalized_namespace
            ]

    def metadata(
        self,
        *,
        namespace: str | None = None,
    ) -> list[CacheEntryMetadata]:
        """Return metadata for cached entries."""

        with self._lock:
            values = []

            for (
                entry_namespace,
                _entry_hash,
            ), item in self._items.items():
                if (
                    namespace is not None
                    and entry_namespace
                    != normalize_namespace(
                        namespace
                    )
                ):
                    continue

                values.append(
                    item.metadata
                )

            return values

    def _delete_unlocked(
        self,
        identity: tuple[str, str],
    ) -> bool:
        """Delete one entry while the cache lock is held."""

        item = self._items.pop(
            identity,
            None,
        )

        if item is None:
            return False

        self._bytes = max(
            0,
            self._bytes
            - item.estimated_bytes,
        )

        self.statistics.deletes += 1

        return True

    def _evict_unlocked(self) -> None:
        """Evict least-recently-used entries until limits are met."""

        while self._items and (
            len(self._items)
            > self.maximum_entries
            or self._bytes
            > self.maximum_bytes
        ):
            _identity, item = (
                self._items.popitem(
                    last=False
                )
            )

            self._bytes = max(
                0,
                self._bytes
                - item.estimated_bytes,
            )

            self.statistics.evictions += 1


class CacheFileLock:
    """
    Exclusive filesystem lock used for one persistent cache entry.
    """

    def __init__(
        self,
        path: Path,
        *,
        timeout_seconds: float = (
            DEFAULT_LOCK_TIMEOUT_SECONDS
        ),
        poll_seconds: float = (
            DEFAULT_LOCK_POLL_SECONDS
        ),
        stale_seconds: float = (
            DEFAULT_STALE_LOCK_SECONDS
        ),
        statistics: CacheStatistics | None = None,
    ) -> None:
        self.path = Path(path)

        self.timeout_seconds = max(
            0.0,
            float(timeout_seconds),
        )

        self.poll_seconds = max(
            0.01,
            float(poll_seconds),
        )

        self.stale_seconds = max(
            1.0,
            float(stale_seconds),
        )

        self.statistics = statistics

        self._file_descriptor: int | None = None
        self._depth = 0
        self._thread_lock = threading.RLock()

    def __enter__(
        self,
    ) -> CacheFileLock:
        self.acquire()
        return self

    def __exit__(
        self,
        exc_type: Any,
        exc_value: Any,
        traceback: Any,
    ) -> None:
        self.release()

    def acquire(self) -> None:
        """Acquire the lock."""

        with self._thread_lock:
            if self._depth > 0:
                self._depth += 1
                return

            self.path.parent.mkdir(
                parents=True,
                exist_ok=True,
                mode=DEFAULT_DIRECTORY_MODE,
            )

            deadline = (
                time.monotonic()
                + self.timeout_seconds
            )

            while True:
                self._remove_stale_lock()

                try:
                    file_descriptor = os.open(
                        self.path,
                        (
                            os.O_CREAT
                            | os.O_EXCL
                            | os.O_WRONLY
                        ),
                        DEFAULT_FILE_MODE,
                    )

                except FileExistsError:
                    if (
                        time.monotonic()
                        >= deadline
                    ):
                        if self.statistics:
                            self.statistics.lock_failures += 1

                        raise CacheLockError(
                            "Timed out waiting for "
                            f"cache lock: {self.path}"
                        )

                    time.sleep(
                        self.poll_seconds
                    )

                    continue

                except OSError as error:
                    if self.statistics:
                        self.statistics.lock_failures += 1

                    raise CacheLockError(
                        "Unable to acquire cache "
                        f"lock {self.path}: {error}"
                    ) from error

                lock_payload = {
                    "pid": os.getpid(),
                    "thread_id": (
                        threading.get_ident()
                    ),
                    "created_at": utc_now(),
                    "created_epoch": time.time(),
                }

                os.write(
                    file_descriptor,
                    json.dumps(
                        lock_payload,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ).encode("utf-8"),
                )

                os.fsync(
                    file_descriptor
                )

                self._file_descriptor = (
                    file_descriptor
                )

                self._depth = 1
                return

    def release(self) -> None:
        """Release the lock."""

        with self._thread_lock:
            if self._depth == 0:
                return

            self._depth -= 1

            if self._depth > 0:
                return

            try:
                if (
                    self._file_descriptor
                    is not None
                ):
                    os.close(
                        self._file_descriptor
                    )

            finally:
                self._file_descriptor = None

                try:
                    self.path.unlink(
                        missing_ok=True
                    )
                except OSError:
                    pass

    def _remove_stale_lock(self) -> None:
        """Remove a stale cache lock."""

        if not self.path.exists():
            return

        try:
            age = (
                time.time()
                - self.path.stat().st_mtime
            )
        except OSError:
            return

        if age < self.stale_seconds:
            return

        try:
            self.path.unlink(
                missing_ok=True
            )
        except OSError:
            return
