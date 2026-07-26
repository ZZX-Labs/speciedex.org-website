#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/cache_manager.py

Namespace facade and unified memory/disk cache manager.

This module is an internal component of the public cache.py compatibility
wrapper. Import public cache APIs from static.tools.core.cache.

Copyright (c) 2026 ZZX-Laboratories
Licensed under the MIT License.
"""

from __future__ import annotations

try:
    from .cache_common import *
    from .cache_memory import MemoryLRUCache
    from .cache_disk import PersistentDiskCache
except ImportError:  # Direct-module compatibility.
    from cache_common import *
    from cache_memory import MemoryLRUCache
    from cache_disk import PersistentDiskCache

class NamespaceCache(Generic[ValueType]):
    """
    Namespace-bound facade over CacheManager.

    The complete CacheManager implementation appears in Part 3.
    """

    def __init__(
        self,
        manager: CacheManager,
        namespace: str,
        *,
        policy: CachePolicy | None = None,
    ) -> None:
        self.manager = manager

        self.namespace = (
            normalize_namespace(
                namespace
            )
        )

        self.policy = (
            policy
            if policy is not None
            else manager.policy_for(
                self.namespace
            )
        )

    def get(
        self,
        key: Any,
        default: ValueType | None = None,
        *,
        allow_stale: bool = False,
    ) -> ValueType | None:
        """Read a value from this namespace."""

        entry = self.manager.get_entry(
            key,
            namespace=self.namespace,
            policy=self.policy,
            allow_stale=allow_stale,
        )

        if entry is None:
            return default

        return entry.value

    def get_entry(
        self,
        key: Any,
        *,
        allow_stale: bool = False,
    ) -> CacheEntry[ValueType] | None:
        """Read a complete cache entry."""

        return self.manager.get_entry(
            key,
            namespace=self.namespace,
            policy=self.policy,
            allow_stale=allow_stale,
        )

    def set(
        self,
        key: Any,
        value: ValueType,
        *,
        ttl_seconds: int | None = None,
        stale_ttl_seconds: int | None = None,
        tags: Iterable[str] | None = None,
        source: str = "",
        extra: Mapping[str, Any] | None = None,
    ) -> bool:
        """Write a value into this namespace."""

        return self.manager.set(
            key,
            value,
            namespace=self.namespace,
            policy=self.policy,
            ttl_seconds=ttl_seconds,
            stale_ttl_seconds=(
                stale_ttl_seconds
            ),
            tags=tags,
            source=source,
            extra=extra,
        )

    def delete(
        self,
        key: Any,
    ) -> bool:
        """Delete one namespace entry."""

        return self.manager.delete(
            key,
            namespace=self.namespace,
        )

    def contains(
        self,
        key: Any,
        *,
        allow_stale: bool = False,
    ) -> bool:
        """Return whether one namespace entry exists."""

        return self.manager.contains(
            key,
            namespace=self.namespace,
            allow_stale=allow_stale,
        )

    def clear(self) -> int:
        """Clear this namespace."""

        return self.manager.clear(
            namespace=self.namespace
        )

    def get_or_set(
        self,
        key: Any,
        factory: Callable[
            [],
            ValueType,
        ],
        *,
        allow_stale: bool = False,
        ttl_seconds: int | None = None,
        stale_ttl_seconds: int | None = None,
        tags: Iterable[str] | None = None,
        source: str = "",
        extra: Mapping[str, Any] | None = None,
    ) -> ValueType:
        """Return a cached value or compute and store it."""

        return self.manager.get_or_set(
            key,
            factory,
            namespace=self.namespace,
            policy=self.policy,
            allow_stale=allow_stale,
            ttl_seconds=ttl_seconds,
            stale_ttl_seconds=(
                stale_ttl_seconds
            ),
            tags=tags,
            source=source,
            extra=extra,
        )

class CacheManager:
    """
    Unified two-layer cache manager.

    Read order:

        memory
        disk
        factory/network/database fallback

    Successful disk reads may be promoted into memory. Writes may target
    either or both layers according to the active CachePolicy.
    """

    def __init__(
        self,
        root: Path,
        *,
        default_policy: CachePolicy | None = None,
        namespace_policies: Mapping[
            str,
            CachePolicy
            | Mapping[str, Any]
        ] | None = None,
        memory_maximum_entries: int = (
            DEFAULT_MEMORY_MAX_ENTRIES
        ),
        memory_maximum_bytes: int = (
            DEFAULT_MEMORY_MAX_BYTES
        ),
        disk_maximum_entries: int = (
            DEFAULT_DISK_MAX_ENTRIES
        ),
        disk_maximum_bytes: int = (
            DEFAULT_DISK_MAX_BYTES
        ),
        prune_interval_seconds: int = (
            DEFAULT_PRUNE_INTERVAL_SECONDS
        ),
        lock_timeout_seconds: float = (
            DEFAULT_LOCK_TIMEOUT_SECONDS
        ),
        lock_poll_seconds: float = (
            DEFAULT_LOCK_POLL_SECONDS
        ),
        stale_lock_seconds: float = (
            DEFAULT_STALE_LOCK_SECONDS
        ),
        auto_prune: bool = True,
    ) -> None:
        self.root = Path(root)

        self.root.mkdir(
            parents=True,
            exist_ok=True,
            mode=DEFAULT_DIRECTORY_MODE,
        )

        self.default_policy = (
            default_policy
            if default_policy is not None
            else CachePolicy()
        )

        self.namespace_policies: dict[
            str,
            CachePolicy,
        ] = {}

        self.statistics = (
            CacheStatistics()
        )

        self.memory = MemoryLRUCache[Any](
            maximum_entries=(
                memory_maximum_entries
            ),
            maximum_bytes=(
                memory_maximum_bytes
            ),
            statistics=self.statistics,
        )

        self.disk = PersistentDiskCache(
            self.root,
            maximum_entries=(
                disk_maximum_entries
            ),
            maximum_bytes=(
                disk_maximum_bytes
            ),
            lock_timeout_seconds=(
                lock_timeout_seconds
            ),
            lock_poll_seconds=(
                lock_poll_seconds
            ),
            stale_lock_seconds=(
                stale_lock_seconds
            ),
            statistics=self.statistics,
        )

        self.prune_interval_seconds = max(
            0,
            int(prune_interval_seconds),
        )

        self.auto_prune = bool(
            auto_prune
        )

        self._last_prune_at = 0.0
        self._manager_lock = (
            threading.RLock()
        )

        self._stampede_locks: dict[
            tuple[str, str],
            threading.Lock,
        ] = {}

        self._stampede_lock_guard = (
            threading.RLock()
        )

        if namespace_policies:
            for (
                namespace,
                policy,
            ) in namespace_policies.items():
                self.register_policy(
                    namespace,
                    policy,
                )

    def namespace(
        self,
        name: str,
        *,
        policy: CachePolicy | None = None,
    ) -> NamespaceCache[Any]:
        """Return a namespace-bound cache facade."""

        return NamespaceCache(
            self,
            name,
            policy=policy,
        )

    def register_policy(
        self,
        namespace: str,
        policy: CachePolicy
        | Mapping[str, Any],
    ) -> CachePolicy:
        """Register or replace one namespace policy."""

        normalized_namespace = (
            normalize_namespace(
                namespace
            )
        )

        if isinstance(
            policy,
            CachePolicy,
        ):
            normalized_policy = policy

        elif isinstance(
            policy,
            Mapping,
        ):
            normalized_policy = (
                CachePolicy(
                    **dict(policy)
                )
            )

        else:
            raise TypeError(
                "Cache policy must be a "
                "CachePolicy or mapping."
            )

        self.namespace_policies[
            normalized_namespace
        ] = normalized_policy

        return normalized_policy

    def remove_policy(
        self,
        namespace: str,
    ) -> bool:
        """Remove one namespace-specific policy."""

        normalized_namespace = (
            normalize_namespace(
                namespace
            )
        )

        return (
            self.namespace_policies.pop(
                normalized_namespace,
                None,
            )
            is not None
        )

    def policy_for(
        self,
        namespace: str,
    ) -> CachePolicy:
        """Return the active policy for one namespace."""

        return self.namespace_policies.get(
            normalize_namespace(
                namespace
            ),
            self.default_policy,
        )

    def get(
        self,
        key: Any,
        default: Any = None,
        *,
        namespace: str = DEFAULT_NAMESPACE,
        policy: CachePolicy | None = None,
        allow_stale: bool = False,
    ) -> Any:
        """Return one cached value or a default."""

        entry = self.get_entry(
            key,
            namespace=namespace,
            policy=policy,
            allow_stale=allow_stale,
        )

        if entry is None:
            return default

        return entry.value

    def get_entry(
        self,
        key: Any,
        *,
        namespace: str = DEFAULT_NAMESPACE,
        policy: CachePolicy | None = None,
        allow_stale: bool = False,
    ) -> CacheEntry[Any] | None:
        """Read one entry from memory or disk."""

        normalized_namespace = (
            normalize_namespace(
                namespace
            )
        )

        active_policy = (
            policy
            if policy is not None
            else self.policy_for(
                normalized_namespace
            )
        )

        canonical_key, key_digest = (
            cache_key(
                key,
                namespace=(
                    normalized_namespace
                ),
            )
        )

        self._maybe_prune()

        if active_policy.memory:
            memory_entry = self.memory.get(
                normalized_namespace,
                key_digest,
                allow_stale=allow_stale,
                refresh_on_access=(
                    active_policy
                    .refresh_on_access
                ),
            )

            if memory_entry is not None:
                return memory_entry

        if active_policy.disk:
            disk_entry = self.disk.get(
                normalized_namespace,
                key_digest,
                allow_stale=allow_stale,
                verify_payload=(
                    active_policy
                    .verify_hash
                ),
                touch=(
                    active_policy
                    .refresh_on_access
                ),
            )

            if disk_entry is not None:
                if active_policy.memory:
                    self.memory.set(
                        normalized_namespace,
                        key_digest,
                        disk_entry.value,
                        disk_entry.metadata,
                    )

                return disk_entry

        return None

    def set(
        self,
        key: Any,
        value: Any,
        *,
        namespace: str = DEFAULT_NAMESPACE,
        policy: CachePolicy | None = None,
        ttl_seconds: int | None = None,
        stale_ttl_seconds: int | None = None,
        tags: Iterable[str] | None = None,
        source: str = "",
        content_type: str = "",
        etag: str = "",
        last_modified: str = "",
        status_code: int | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> bool:
        """Store one value according to the active policy."""

        normalized_namespace = (
            normalize_namespace(
                namespace
            )
        )

        active_policy = self._effective_policy(
            policy
            if policy is not None
            else self.policy_for(
                normalized_namespace
            ),
            ttl_seconds=ttl_seconds,
            stale_ttl_seconds=(
                stale_ttl_seconds
            ),
        )

        if (
            value is None
            and not active_policy.cache_none
        ):
            return False

        canonical_key, key_digest = (
            cache_key(
                key,
                namespace=(
                    normalized_namespace
                ),
            )
        )

        if (
            not active_policy.memory
            and not active_policy.disk
        ):
            return False

        metadata: (
            CacheEntryMetadata
            | None
        ) = None

        if active_policy.disk:
            metadata = self.disk.set(
                namespace=(
                    normalized_namespace
                ),
                key=canonical_key,
                key_hash_value=(
                    key_digest
                ),
                value=value,
                policy=active_policy,
                tags=tags,
                source=source,
                content_type=(
                    content_type
                ),
                etag=etag,
                last_modified=(
                    last_modified
                ),
                status_code=status_code,
                extra=extra,
            )

        if metadata is None:
            current_time = time.time()

            expires_at = (
                current_time
                + active_policy.ttl_seconds
                if active_policy.ttl_seconds
                > 0
                else None
            )

            stale_until = (
                (
                    expires_at
                    + active_policy
                    .stale_ttl_seconds
                )
                if (
                    expires_at is not None
                    and active_policy
                    .stale_ttl_seconds
                    > 0
                )
                else expires_at
            )

            metadata = (
                CacheEntryMetadata(
                    schema_version=(
                        CACHE_SCHEMA_VERSION
                    ),
                    namespace=(
                        normalized_namespace
                    ),
                    key=canonical_key,
                    key_hash=key_digest,
                    created_at=current_time,
                    updated_at=current_time,
                    accessed_at=current_time,
                    expires_at=expires_at,
                    stale_until=(
                        stale_until
                    ),
                    serializer=(
                        active_policy
                        .serializer
                    ),
                    compression=(
                        COMPRESSION_NONE
                    ),
                    payload_hash="",
                    payload_bytes=(
                        estimate_size_bytes(
                            value
                        )
                    ),
                    stored_bytes=0,
                    hits=0,
                    tags=sorted(
                        {
                            normalize_key(tag)
                            for tag in (
                                tags or []
                            )
                            if normalize_key(
                                tag
                            )
                        }
                    ),
                    source=normalize_space(
                        source
                    ),
                    content_type=(
                        normalize_space(
                            content_type
                        )
                    ),
                    etag=normalize_space(
                        etag
                    ),
                    last_modified=(
                        normalize_space(
                            last_modified
                        )
                    ),
                    status_code=(
                        int(status_code)
                        if status_code
                        is not None
                        else None
                    ),
                    extra=dict(
                        extra or {}
                    ),
                )
            )

        if active_policy.memory:
            self.memory.set(
                normalized_namespace,
                key_digest,
                value,
                metadata,
            )

        if not active_policy.disk:
            self.statistics.writes += 1

        self._maybe_prune()

        return True

    def contains(
        self,
        key: Any,
        *,
        namespace: str = DEFAULT_NAMESPACE,
        allow_stale: bool = False,
        policy: CachePolicy | None = None,
    ) -> bool:
        """Return whether a usable entry exists."""

        return (
            self.get_entry(
                key,
                namespace=namespace,
                policy=policy,
                allow_stale=allow_stale,
            )
            is not None
        )

    def metadata(
        self,
        key: Any,
        *,
        namespace: str = DEFAULT_NAMESPACE,
    ) -> CacheEntryMetadata | None:
        """Return metadata for one key."""

        normalized_namespace = (
            normalize_namespace(
                namespace
            )
        )

        _canonical_key, key_digest = (
            cache_key(
                key,
                namespace=(
                    normalized_namespace
                ),
            )
        )

        for metadata in self.memory.metadata(
            namespace=(
                normalized_namespace
            )
        ):
            if (
                metadata.key_hash
                == key_digest
            ):
                return metadata

        return self.disk.metadata(
            normalized_namespace,
            key_digest,
        )

    def delete(
        self,
        key: Any,
        *,
        namespace: str = DEFAULT_NAMESPACE,
    ) -> bool:
        """Delete one key from all cache layers."""

        normalized_namespace = (
            normalize_namespace(
                namespace
            )
        )

        _canonical_key, key_digest = (
            cache_key(
                key,
                namespace=(
                    normalized_namespace
                ),
            )
        )

        memory_deleted = self.memory.delete(
            normalized_namespace,
            key_digest,
        )

        disk_deleted = self.disk.delete(
            normalized_namespace,
            key_digest,
        )

        return (
            memory_deleted
            or disk_deleted
        )

    def clear(
        self,
        *,
        namespace: str | None = None,
    ) -> int:
        """Clear one namespace or the entire cache."""

        memory_count = self.memory.clear(
            namespace=namespace
        )

        disk_count = self.disk.clear(
            namespace=namespace
        )

        return max(
            memory_count,
            disk_count,
        )

    def get_or_set(
        self,
        key: Any,
        factory: Callable[[], Any],
        *,
        namespace: str = DEFAULT_NAMESPACE,
        policy: CachePolicy | None = None,
        allow_stale: bool = False,
        ttl_seconds: int | None = None,
        stale_ttl_seconds: int | None = None,
        tags: Iterable[str] | None = None,
        source: str = "",
        content_type: str = "",
        etag: str = "",
        last_modified: str = "",
        status_code: int | None = None,
        extra: Mapping[str, Any] | None = None,
    ) -> Any:
        """
        Return a cached value or compute and store it.

        A per-key in-process lock prevents duplicate concurrent factory calls.
        """

        normalized_namespace = (
            normalize_namespace(
                namespace
            )
        )

        active_policy = (
            policy
            if policy is not None
            else self.policy_for(
                normalized_namespace
            )
        )

        entry = self.get_entry(
            key,
            namespace=(
                normalized_namespace
            ),
            policy=active_policy,
            allow_stale=allow_stale,
        )

        if entry is not None:
            return entry.value

        _canonical_key, key_digest = (
            cache_key(
                key,
                namespace=(
                    normalized_namespace
                ),
            )
        )

        stampede_lock = (
            self._stampede_lock(
                normalized_namespace,
                key_digest,
            )
        )

        with stampede_lock:
            entry = self.get_entry(
                key,
                namespace=(
                    normalized_namespace
                ),
                policy=active_policy,
                allow_stale=allow_stale,
            )

            if entry is not None:
                return entry.value

            value = factory()

            self.set(
                key,
                value,
                namespace=(
                    normalized_namespace
                ),
                policy=active_policy,
                ttl_seconds=ttl_seconds,
                stale_ttl_seconds=(
                    stale_ttl_seconds
                ),
                tags=tags,
                source=source,
                content_type=(
                    content_type
                ),
                etag=etag,
                last_modified=(
                    last_modified
                ),
                status_code=status_code,
                extra=extra,
            )

            return value

    def invalidate_tag(
        self,
        tag: str,
        *,
        namespace: str | None = None,
    ) -> int:
        """Delete all entries carrying a tag."""

        normalized_tag = normalize_key(
            tag
        )

        if not normalized_tag:
            return 0

        metadata_entries = (
            self.disk.find_by_tag(
                normalized_tag,
                namespace=namespace,
            )
        )

        deleted = 0

        for metadata in metadata_entries:
            if self.delete_hash(
                metadata.key_hash,
                namespace=(
                    metadata.namespace
                ),
            ):
                deleted += 1

        return deleted

    def invalidate_source(
        self,
        source: str,
        *,
        namespace: str | None = None,
    ) -> int:
        """Delete all persistent entries matching a source."""

        normalized_source = (
            normalize_space(
                source
            )
        )

        if not normalized_source:
            return 0

        metadata_entries = (
            self.disk.find_by_source(
                normalized_source,
                namespace=namespace,
            )
        )

        deleted = 0

        for metadata in metadata_entries:
            if self.delete_hash(
                metadata.key_hash,
                namespace=(
                    metadata.namespace
                ),
            ):
                deleted += 1

        return deleted

    def delete_hash(
        self,
        key_hash_value: str,
        *,
        namespace: str,
    ) -> bool:
        """Delete one entry using its normalized hash."""

        normalized_namespace = (
            normalize_namespace(
                namespace
            )
        )

        normalized_hash = normalize_key(
            key_hash_value
        )

        memory_deleted = self.memory.delete(
            normalized_namespace,
            normalized_hash,
        )

        disk_deleted = self.disk.delete(
            normalized_namespace,
            normalized_hash,
        )

        return (
            memory_deleted
            or disk_deleted
        )

    def prune(
        self,
        *,
        namespace: str | None = None,
        delete_stale: bool = False,
    ) -> CachePruneResult:
        """Prune both cache layers."""

        self.memory.prune()

        result = self.disk.prune(
            namespace=namespace,
            delete_stale=delete_stale,
        )

        self._last_prune_at = time.time()

        return result

    def verify(
        self,
        *,
        namespace: str | None = None,
        verify_payloads: bool = True,
    ) -> CacheVerification:
        """Verify the persistent cache."""

        return self.disk.verify(
            namespace=namespace,
            verify_payloads=(
                verify_payloads
            ),
        )

    def usage(
        self,
        *,
        namespace: str | None = None,
    ) -> dict[str, Any]:
        """Return combined memory and disk usage."""

        disk_usage = self.disk.usage(
            namespace=namespace
        )

        return {
            "memory": {
                "entries": len(
                    self.memory
                ),
                "estimated_bytes": (
                    self.memory.size_bytes
                ),
                "maximum_entries": (
                    self.memory
                    .maximum_entries
                ),
                "maximum_bytes": (
                    self.memory
                    .maximum_bytes
                ),
            },
            "disk": {
                **disk_usage,
                "maximum_entries": (
                    self.disk
                    .maximum_entries
                ),
                "maximum_bytes": (
                    self.disk
                    .maximum_bytes
                ),
            },
            "statistics": (
                self.statistics.to_dict()
            ),
        }

    def export_metadata(
        self,
        path: Path,
        *,
        namespace: str | None = None,
    ) -> None:
        """Write cache metadata and usage as JSON."""

        metadata_entries = [
            metadata.to_dict()
            for metadata
            in self.disk.iter_metadata(
                namespace=namespace
            )
        ]

        atomic_write_json(
            Path(path),
            {
                "schema_version": (
                    CACHE_SCHEMA_VERSION
                ),
                "generated_at": utc_now(),
                "namespace": (
                    normalize_namespace(
                        namespace
                    )
                    if namespace
                    is not None
                    else None
                ),
                "usage": self.usage(
                    namespace=namespace
                ),
                "entries": (
                    metadata_entries
                ),
            },
        )

    def cached(
        self,
        *,
        namespace: str,
        key_builder: Callable[
            ...,
            Any
        ] | None = None,
        policy: CachePolicy | None = None,
        ttl_seconds: int | None = None,
        stale_ttl_seconds: int | None = None,
        allow_stale: bool = False,
        tags: Iterable[str] | None = None,
    ) -> Callable[
        [Callable[..., ValueType]],
        Callable[..., ValueType],
    ]:
        """
        Return a decorator that caches function results.
        """

        normalized_namespace = (
            normalize_namespace(
                namespace
            )
        )

        def decorator(
            function: Callable[
                ...,
                ValueType
            ],
        ) -> Callable[
            ...,
            ValueType
        ]:
            def wrapped(
                *args: Any,
                **kwargs: Any,
            ) -> ValueType:
                if key_builder is not None:
                    key_value = key_builder(
                        *args,
                        **kwargs,
                    )
                else:
                    key_value = {
                        "module": (
                            function.__module__
                        ),
                        "qualname": (
                            function.__qualname__
                        ),
                        "args": args,
                        "kwargs": kwargs,
                    }

                return self.get_or_set(
                    key_value,
                    lambda: function(
                        *args,
                        **kwargs,
                    ),
                    namespace=(
                        normalized_namespace
                    ),
                    policy=policy,
                    allow_stale=(
                        allow_stale
                    ),
                    ttl_seconds=(
                        ttl_seconds
                    ),
                    stale_ttl_seconds=(
                        stale_ttl_seconds
                    ),
                    tags=tags,
                    source=(
                        function.__qualname__
                    ),
                )

            wrapped.__name__ = (
                function.__name__
            )

            wrapped.__qualname__ = (
                function.__qualname__
            )

            wrapped.__doc__ = (
                function.__doc__
            )

            wrapped.__module__ = (
                function.__module__
            )

            return wrapped

        return decorator

    def _effective_policy(
        self,
        policy: CachePolicy,
        *,
        ttl_seconds: int | None,
        stale_ttl_seconds: int | None,
    ) -> CachePolicy:
        """Return a copy of a policy with optional TTL overrides."""

        values = policy.to_dict()

        if ttl_seconds is not None:
            values["ttl_seconds"] = max(
                0,
                int(ttl_seconds),
            )

        if stale_ttl_seconds is not None:
            values[
                "stale_ttl_seconds"
            ] = max(
                0,
                int(
                    stale_ttl_seconds
                ),
            )

        return CachePolicy(
            **values
        )

    def _stampede_lock(
        self,
        namespace: str,
        key_hash_value: str,
    ) -> threading.Lock:
        """Return a stable in-process lock for one cache key."""

        identity = (
            normalize_namespace(
                namespace
            ),
            normalize_key(
                key_hash_value
            ),
        )

        with self._stampede_lock_guard:
            lock = (
                self._stampede_locks.get(
                    identity
                )
            )

            if lock is None:
                lock = threading.Lock()

                self._stampede_locks[
                    identity
                ] = lock

            return lock

    def _maybe_prune(self) -> None:
        """Run interval-based automatic pruning."""

        if (
            not self.auto_prune
            or self.prune_interval_seconds
            <= 0
        ):
            return

        current = time.time()

        if (
            current
            - self._last_prune_at
            < self.prune_interval_seconds
        ):
            return

        with self._manager_lock:
            current = time.time()

            if (
                current
                - self._last_prune_at
                < self.prune_interval_seconds
            ):
                return

            self.prune()
