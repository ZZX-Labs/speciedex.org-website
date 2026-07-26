#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/cache.py

Public compatibility wrapper for the modular Speciedex cache subsystem.

The original monolithic implementation has been separated by responsibility
without changing its public import surface. Existing callers may continue to
import classes, functions, and constants from static.tools.core.cache.

Internal modules:

- cache_common.py
- cache_memory.py
- cache_disk.py
- cache_manager.py
- cache_http.py
- cache_domains.py
- cache_specialized.py
- cache_operations.py

Copyright (c) 2026 ZZX-Laboratories
Licensed under the MIT License.
"""

from __future__ import annotations

try:
    from .cache_common import *
    from .cache_memory import *
    from .cache_disk import *
    from .cache_manager import *
    from .cache_http import *
    from .cache_domains import *
    from .cache_specialized import *
    from .cache_operations import *
except ImportError:  # Direct-module compatibility.
    from cache_common import *
    from cache_memory import *
    from cache_disk import *
    from cache_manager import *
    from cache_http import *
    from cache_domains import *
    from cache_specialized import *
    from cache_operations import *

def default_namespace_policies(
) -> dict[str, CachePolicy]:
    """Return recommended Speciedex namespace policies."""

    return {
        "http": CachePolicy(
            ttl_seconds=60 * 60,
            stale_ttl_seconds=(
                24 * 60 * 60
            ),
            memory=True,
            disk=True,
            serializer=SERIALIZER_PICKLE,
            compression=COMPRESSION_GZIP,
            cache_none=False,
            verify_hash=True,
        ),
        "providers": CachePolicy(
            ttl_seconds=6 * 60 * 60,
            stale_ttl_seconds=(
                7 * 24 * 60 * 60
            ),
            memory=True,
            disk=True,
            serializer=SERIALIZER_PICKLE,
            compression=COMPRESSION_GZIP,
            cache_none=False,
            verify_hash=True,
        ),
        "batches": CachePolicy(
            ttl_seconds=12 * 60 * 60,
            stale_ttl_seconds=(
                7 * 24 * 60 * 60
            ),
            memory=True,
            disk=True,
            serializer=SERIALIZER_PICKLE,
            compression=COMPRESSION_GZIP,
            cache_none=False,
            verify_hash=True,
        ),
        "taxonomy": CachePolicy(
            ttl_seconds=24 * 60 * 60,
            stale_ttl_seconds=(
                30 * 24 * 60 * 60
            ),
            memory=True,
            disk=True,
            serializer=SERIALIZER_PICKLE,
            compression=COMPRESSION_GZIP,
            cache_none=True,
            verify_hash=True,
        ),
        "authority": CachePolicy(
            ttl_seconds=(
                30 * 24 * 60 * 60
            ),
            stale_ttl_seconds=(
                180 * 24 * 60 * 60
            ),
            memory=True,
            disk=True,
            serializer=SERIALIZER_PICKLE,
            compression=COMPRESSION_GZIP,
            cache_none=True,
            verify_hash=True,
        ),
        "lineage": CachePolicy(
            ttl_seconds=24 * 60 * 60,
            stale_ttl_seconds=(
                30 * 24 * 60 * 60
            ),
            memory=True,
            disk=True,
            serializer=SERIALIZER_PICKLE,
            compression=COMPRESSION_GZIP,
            cache_none=True,
            verify_hash=True,
        ),
        "statistics": CachePolicy(
            ttl_seconds=15 * 60,
            stale_ttl_seconds=(
                6 * 60 * 60
            ),
            memory=True,
            disk=True,
            serializer=SERIALIZER_JSON,
            compression=COMPRESSION_GZIP,
            cache_none=False,
            verify_hash=True,
        ),
        "sqlite": CachePolicy(
            ttl_seconds=15 * 60,
            stale_ttl_seconds=0,
            memory=True,
            disk=False,
            serializer=SERIALIZER_PICKLE,
            compression=COMPRESSION_NONE,
            cache_none=True,
            verify_hash=False,
        ),
        "reconciliation": CachePolicy(
            ttl_seconds=30 * 60,
            stale_ttl_seconds=0,
            memory=True,
            disk=False,
            serializer=SERIALIZER_PICKLE,
            compression=COMPRESSION_NONE,
            cache_none=True,
            verify_hash=False,
        ),
        "synonyms": CachePolicy(
            ttl_seconds=30 * 60,
            stale_ttl_seconds=(
                6 * 60 * 60
            ),
            memory=True,
            disk=False,
            serializer=SERIALIZER_PICKLE,
            compression=COMPRESSION_NONE,
            cache_none=True,
            verify_hash=False,
        ),
        "deduplication": CachePolicy(
            ttl_seconds=30 * 60,
            stale_ttl_seconds=0,
            memory=True,
            disk=False,
            serializer=SERIALIZER_PICKLE,
            compression=COMPRESSION_NONE,
            cache_none=True,
            verify_hash=False,
        ),
        "manifest": CachePolicy(
            ttl_seconds=5 * 60,
            stale_ttl_seconds=0,
            memory=True,
            disk=False,
            serializer=SERIALIZER_PICKLE,
            compression=COMPRESSION_NONE,
            cache_none=False,
            verify_hash=False,
        ),
        "history": CachePolicy(
            ttl_seconds=10 * 60,
            stale_ttl_seconds=(
                60 * 60
            ),
            memory=True,
            disk=False,
            serializer=SERIALIZER_PICKLE,
            compression=COMPRESSION_NONE,
            cache_none=False,
            verify_hash=False,
        ),
    }


@dataclass(slots=True)
class CacheBundle:
    """
    Complete Speciedex cache facade bundle.
    """

    manager: CacheManager
    http: HTTPResponseCache
    providers: ProviderCache
    batches: BatchCache
    taxonomy: TaxonomyCache
    synonyms: SynonymCache
    authority: AuthorityCache
    lineage: LineageCache
    statistics: StatisticsCache
    sqlite: SQLiteLookupCache
    reconciliation: ReconciliationCache
    deduplication: DeduplicationCache
    manifest: ManifestCache
    history: HistoryCache

    def verify(
        self,
        *,
        verify_payloads: bool = True,
    ) -> CacheVerification:
        """Verify all persistent cache namespaces."""

        return self.manager.verify(
            verify_payloads=(
                verify_payloads
            )
        )

    def prune(
        self,
        *,
        delete_stale: bool = False,
    ) -> CachePruneResult:
        """Prune all cache namespaces."""

        return self.manager.prune(
            delete_stale=delete_stale
        )

    def usage(self) -> dict[str, Any]:
        """Return combined cache usage."""

        return self.manager.usage()

    def clear(self) -> int:
        """Clear all cache data."""

        return self.manager.clear()

    def close(
        self,
        *,
        prune: bool = False,
    ) -> None:
        """Perform optional shutdown pruning."""

        if prune:
            self.manager.prune()


def create_cache_bundle(
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
    auto_prune: bool = True,
) -> CacheBundle:
    """Create a complete Speciedex cache bundle."""

    policies = (
        dict(
            namespace_policies
        )
        if namespace_policies is not None
        else default_namespace_policies()
    )

    manager = CacheManager(
        Path(root),
        default_policy=(
            default_policy
            if default_policy
            is not None
            else CachePolicy()
        ),
        namespace_policies=policies,
        memory_maximum_entries=(
            memory_maximum_entries
        ),
        memory_maximum_bytes=(
            memory_maximum_bytes
        ),
        disk_maximum_entries=(
            disk_maximum_entries
        ),
        disk_maximum_bytes=(
            disk_maximum_bytes
        ),
        prune_interval_seconds=(
            prune_interval_seconds
        ),
        auto_prune=auto_prune,
    )

    return CacheBundle(
        manager=manager,
        http=HTTPResponseCache(
            manager,
            policy=manager.policy_for(
                "http"
            ),
        ),
        providers=ProviderCache(
            manager,
            policy=manager.policy_for(
                "providers"
            ),
        ),
        batches=BatchCache(
            manager,
            policy=manager.policy_for(
                "batches"
            ),
        ),
        taxonomy=TaxonomyCache(
            manager,
            policy=manager.policy_for(
                "taxonomy"
            ),
        ),
        synonyms=SynonymCache(
            manager,
            policy=manager.policy_for(
                "synonyms"
            ),
        ),
        authority=AuthorityCache(
            manager,
            policy=manager.policy_for(
                "authority"
            ),
        ),
        lineage=LineageCache(
            manager,
            policy=manager.policy_for(
                "lineage"
            ),
        ),
        statistics=StatisticsCache(
            manager,
            policy=manager.policy_for(
                "statistics"
            ),
        ),
        sqlite=SQLiteLookupCache(
            manager,
            policy=manager.policy_for(
                "sqlite"
            ),
        ),
        reconciliation=(
            ReconciliationCache(
                manager,
                policy=(
                    manager.policy_for(
                        "reconciliation"
                    )
                ),
            )
        ),
        deduplication=(
            DeduplicationCache(
                manager,
                policy=(
                    manager.policy_for(
                        "deduplication"
                    )
                ),
            )
        ),
        manifest=ManifestCache(
            manager,
            policy=manager.policy_for(
                "manifest"
            ),
        ),
        history=HistoryCache(
            manager,
            policy=manager.policy_for(
                "history"
            ),
        ),
    )


_default_cache_bundle: (
    CacheBundle
    | None
) = None

_default_cache_lock = (
    threading.RLock()
)


def get_default_cache(
    root: Path | None = None,
) -> CacheBundle:
    """
    Return the process-wide default cache bundle.

    The first call must provide a root unless the SPECIEDEX_CACHE_ROOT
    environment variable is configured.
    """

    global _default_cache_bundle

    with _default_cache_lock:
        if (
            _default_cache_bundle
            is not None
        ):
            return _default_cache_bundle

        configured_root = (
            Path(root)
            if root is not None
            else (
                Path(
                    os.environ[
                        "SPECIEDEX_CACHE_ROOT"
                    ]
                )
                if os.environ.get(
                    "SPECIEDEX_CACHE_ROOT"
                )
                else None
            )
        )

        if configured_root is None:
            raise CacheConfigurationError(
                "A default cache root was not "
                "provided and "
                "SPECIEDEX_CACHE_ROOT is unset."
            )

        _default_cache_bundle = (
            create_cache_bundle(
                configured_root
            )
        )

        return _default_cache_bundle


def set_default_cache(
    bundle: CacheBundle | None,
) -> None:
    """Replace or clear the process-wide default cache."""

    global _default_cache_bundle

    with _default_cache_lock:
        _default_cache_bundle = bundle


def close_default_cache(
    *,
    prune: bool = False,
) -> None:
    """Close and clear the process-wide default cache."""

    global _default_cache_bundle

    with _default_cache_lock:
        if (
            _default_cache_bundle
            is not None
        ):
            _default_cache_bundle.close(
                prune=prune
            )

        _default_cache_bundle = None


@contextmanager
def cache_bundle(
    root: Path,
    **kwargs: Any,
) -> Iterator[CacheBundle]:
    """Create and automatically close a temporary cache bundle."""

    bundle = create_cache_bundle(
        root,
        **kwargs,
    )

    try:
        yield bundle

    finally:
        bundle.close()


def cached(
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
    root: Path | None = None,
) -> Callable[
    [Callable[..., ValueType]],
    Callable[..., ValueType],
]:
    """
    Module-level caching decorator using the default cache bundle.
    """

    bundle = get_default_cache(
        root
    )

    return bundle.manager.cached(
        namespace=namespace,
        key_builder=key_builder,
        policy=policy,
        ttl_seconds=ttl_seconds,
        stale_ttl_seconds=(
            stale_ttl_seconds
        ),
        allow_stale=allow_stale,
        tags=tags,
    )


__all__ = [
    "BatchCache",
    "CACHE_COMPRESSED_SUFFIX",
    "CACHE_FILE_SUFFIX",
    "CACHE_KEY_PREFIX",
    "CACHE_LOCK_SUFFIX",
    "CACHE_SCHEMA_VERSION",
    "COMPRESSION_GZIP",
    "COMPRESSION_NONE",
    "CacheBundle",
    "CacheConfigurationError",
    "CacheEntry",
    "CacheEntryMetadata",
    "CacheError",
    "CacheExportResult",
    "CacheFileLock",
    "CacheImportResult",
    "CacheIntegrityError",
    "CacheKeyError",
    "CacheLockError",
    "CacheManager",
    "CachePaths",
    "CachePolicy",
    "CachePruneResult",
    "CacheRebuildResult",
    "CacheSerializationError",
    "CacheStatistics",
    "CacheVerification",
    "CacheWarmResult",
    "CacheWarmTask",
    "CachedBatch",
    "DeduplicationCache",
    "DEFAULT_COMPRESSION_THRESHOLD_BYTES",
    "DEFAULT_DISK_MAX_BYTES",
    "DEFAULT_DISK_MAX_ENTRIES",
    "DEFAULT_LOCK_POLL_SECONDS",
    "DEFAULT_LOCK_TIMEOUT_SECONDS",
    "DEFAULT_MEMORY_MAX_BYTES",
    "DEFAULT_MEMORY_MAX_ENTRIES",
    "DEFAULT_NAMESPACE",
    "DEFAULT_PRUNE_INTERVAL_SECONDS",
    "DEFAULT_STALE_LOCK_SECONDS",
    "DEFAULT_STALE_TTL_SECONDS",
    "DEFAULT_TTL_SECONDS",
    "HistoryCache",
    "HTTPResponseCache",
    "HTTPResponseCacheValue",
    "LineageCache",
    "ManifestCache",
    "MemoryLRUCache",
    "NamespaceCache",
    "PersistentDiskCache",
    "ProviderCache",
    "ProviderCacheRecord",
    "ReconciliationCache",
    "SERIALIZER_JSON",
    "SERIALIZER_PICKLE",
    "SERIALIZER_RAW",
    "SQLiteLookupCache",
    "StatisticsCache",
    "SynonymCache",
    "TaxonomyCache",
    "atomic_write_bytes",
    "atomic_write_json",
    "cache_bundle",
    "cache_key",
    "cached",
    "canonicalize_value",
    "close_default_cache",
    "compress_payload",
    "create_cache_bundle",
    "decompress_payload",
    "default_namespace_policies",
    "deserialize_value",
    "estimate_size_bytes",
    "export_cache",
    "get_default_cache",
    "import_cache",
    "normalize_key",
    "normalize_namespace",
    "normalize_space",
    "payload_hash",
    "read_json",
    "rebuild_cache",
    "serialize_value",
    "set_default_cache",
    "stable_hash",
    "stable_json_bytes",
    "utc_now",
    "verify_hash",
    "warm_cache",
]