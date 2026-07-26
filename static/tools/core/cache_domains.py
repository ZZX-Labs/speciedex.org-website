#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/cache_domains.py

Provider, taxonomy, synonym, authority, lineage, and batch cache facades.

This module is an internal component of the public cache.py compatibility
wrapper. Import public cache APIs from static.tools.core.cache.

Copyright (c) 2026 ZZX-Laboratories
Licensed under the MIT License.
"""

from __future__ import annotations

try:
    from .cache_common import *
    from .cache_manager import CacheManager
except ImportError:  # Direct-module compatibility.
    from cache_common import *
    from cache_manager import CacheManager

class ProviderCacheRecord:
    """Serializable provider cache record."""

    provider: str
    operation: str
    cursor: str
    parameters: dict[str, Any]
    value: Any
    created_at: str
    source_url: str = ""
    request_count: int = 0
    exhausted: bool = False
    next_cursor: str | None = None
    metadata: dict[str, Any] = field(
        default_factory=dict
    )

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible provider cache record."""

        return {
            "provider": self.provider,
            "operation": self.operation,
            "cursor": self.cursor,
            "parameters": dict(
                self.parameters
            ),
            "value": self.value,
            "created_at": self.created_at,
            "source_url": self.source_url,
            "request_count": (
                self.request_count
            ),
            "exhausted": self.exhausted,
            "next_cursor": self.next_cursor,
            "metadata": dict(
                self.metadata
            ),
        }


class ProviderCache:
    """
    Provider API and normalized-record cache.

    Provider cache entries are separated by provider and operation. Raw API
    pages, normalized Taxon batches, cursor metadata, and provider-specific
    lookup results may all be stored independently.
    """

    def __init__(
        self,
        manager: CacheManager,
        *,
        namespace: str = "providers",
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
            else CachePolicy(
                ttl_seconds=6 * 60 * 60,
                stale_ttl_seconds=(
                    7 * 24 * 60 * 60
                ),
                memory=True,
                disk=True,
                serializer=SERIALIZER_PICKLE,
                compression=COMPRESSION_GZIP,
                compress_above_bytes=(
                    DEFAULT_COMPRESSION_THRESHOLD_BYTES
                ),
                cache_none=False,
                verify_hash=True,
            )
        )

    def build_key(
        self,
        *,
        provider: Any,
        operation: Any,
        cursor: Any = "",
        parameters: Mapping[
            str,
            Any,
        ] | None = None,
        version: Any = None,
    ) -> dict[str, Any]:
        """Build a deterministic provider cache key."""

        normalized_provider = (
            normalize_key(provider)
        )

        normalized_operation = (
            normalize_key(operation)
        )

        if not normalized_provider:
            raise CacheKeyError(
                "Provider cache key requires "
                "a provider."
            )

        if not normalized_operation:
            raise CacheKeyError(
                "Provider cache key requires "
                "an operation."
            )

        return {
            "provider": normalized_provider,
            "operation": normalized_operation,
            "cursor": (
                normalize_space(cursor)
            ),
            "parameters": (
                canonicalize_value(
                    parameters or {}
                )
            ),
            "version": (
                canonicalize_value(
                    version
                )
            ),
        }

    def get(
        self,
        *,
        provider: Any,
        operation: Any,
        cursor: Any = "",
        parameters: Mapping[
            str,
            Any,
        ] | None = None,
        version: Any = None,
        allow_stale: bool = False,
    ) -> Any:
        """Return one cached provider value."""

        key_value = self.build_key(
            provider=provider,
            operation=operation,
            cursor=cursor,
            parameters=parameters,
            version=version,
        )

        return self.manager.get(
            key_value,
            namespace=self.namespace,
            policy=self.policy,
            allow_stale=allow_stale,
        )

    def get_entry(
        self,
        *,
        provider: Any,
        operation: Any,
        cursor: Any = "",
        parameters: Mapping[
            str,
            Any,
        ] | None = None,
        version: Any = None,
        allow_stale: bool = False,
    ) -> CacheEntry[Any] | None:
        """Return one complete provider cache entry."""

        key_value = self.build_key(
            provider=provider,
            operation=operation,
            cursor=cursor,
            parameters=parameters,
            version=version,
        )

        return self.manager.get_entry(
            key_value,
            namespace=self.namespace,
            policy=self.policy,
            allow_stale=allow_stale,
        )

    def set(
        self,
        *,
        provider: Any,
        operation: Any,
        value: Any,
        cursor: Any = "",
        parameters: Mapping[
            str,
            Any,
        ] | None = None,
        version: Any = None,
        source_url: str = "",
        request_count: int = 0,
        exhausted: bool = False,
        next_cursor: Any = None,
        metadata: Mapping[
            str,
            Any,
        ] | None = None,
        ttl_seconds: int | None = None,
        stale_ttl_seconds: int | None = None,
    ) -> bool:
        """Store one provider result."""

        normalized_provider = (
            normalize_key(provider)
        )

        normalized_operation = (
            normalize_key(operation)
        )

        key_value = self.build_key(
            provider=normalized_provider,
            operation=normalized_operation,
            cursor=cursor,
            parameters=parameters,
            version=version,
        )

        record = ProviderCacheRecord(
            provider=normalized_provider,
            operation=normalized_operation,
            cursor=normalize_space(cursor),
            parameters=dict(
                parameters or {}
            ),
            value=value,
            created_at=utc_now(),
            source_url=normalize_space(
                source_url
            ),
            request_count=max(
                0,
                int(request_count),
            ),
            exhausted=bool(exhausted),
            next_cursor=(
                None
                if next_cursor is None
                else str(next_cursor)
            ),
            metadata=dict(
                metadata or {}
            ),
        )

        return self.manager.set(
            key_value,
            record,
            namespace=self.namespace,
            policy=self.policy,
            ttl_seconds=ttl_seconds,
            stale_ttl_seconds=(
                stale_ttl_seconds
            ),
            tags=(
                "provider",
                normalized_provider,
                normalized_operation,
            ),
            source=source_url,
            extra={
                "provider": (
                    normalized_provider
                ),
                "operation": (
                    normalized_operation
                ),
                "cursor": (
                    normalize_space(
                        cursor
                    )
                ),
            },
        )

    def get_value(
        self,
        **kwargs: Any,
    ) -> Any:
        """Return the payload contained in a cached provider record."""

        record = self.get(
            **kwargs
        )

        if isinstance(
            record,
            ProviderCacheRecord,
        ):
            return record.value

        if isinstance(
            record,
            Mapping,
        ) and "value" in record:
            return record.get(
                "value"
            )

        return record

    def get_or_fetch(
        self,
        *,
        provider: Any,
        operation: Any,
        fetcher: Callable[[], Any],
        cursor: Any = "",
        parameters: Mapping[
            str,
            Any,
        ] | None = None,
        version: Any = None,
        allow_stale: bool = False,
        ttl_seconds: int | None = None,
        stale_ttl_seconds: int | None = None,
        source_url: str = "",
    ) -> Any:
        """Return a cached provider value or call the provider fetcher."""

        key_value = self.build_key(
            provider=provider,
            operation=operation,
            cursor=cursor,
            parameters=parameters,
            version=version,
        )

        def factory() -> ProviderCacheRecord:
            result = fetcher()

            return ProviderCacheRecord(
                provider=normalize_key(
                    provider
                ),
                operation=normalize_key(
                    operation
                ),
                cursor=normalize_space(
                    cursor
                ),
                parameters=dict(
                    parameters or {}
                ),
                value=result,
                created_at=utc_now(),
                source_url=normalize_space(
                    source_url
                ),
            )

        cached = self.manager.get_or_set(
            key_value,
            factory,
            namespace=self.namespace,
            policy=self.policy,
            allow_stale=allow_stale,
            ttl_seconds=ttl_seconds,
            stale_ttl_seconds=(
                stale_ttl_seconds
            ),
            tags=(
                "provider",
                normalize_key(provider),
                normalize_key(operation),
            ),
            source=source_url,
            extra={
                "provider": (
                    normalize_key(provider)
                ),
                "operation": (
                    normalize_key(operation)
                ),
            },
        )

        if isinstance(
            cached,
            ProviderCacheRecord,
        ):
            return cached.value

        if isinstance(
            cached,
            Mapping,
        ) and "value" in cached:
            return cached.get(
                "value"
            )

        return cached

    def invalidate_provider(
        self,
        provider: Any,
    ) -> int:
        """Invalidate all cache entries for one provider."""

        return self.manager.invalidate_tag(
            normalize_key(provider),
            namespace=self.namespace,
        )

    def invalidate_operation(
        self,
        operation: Any,
    ) -> int:
        """Invalidate all provider entries for one operation."""

        return self.manager.invalidate_tag(
            normalize_key(operation),
            namespace=self.namespace,
        )

    def clear(self) -> int:
        """Clear the provider cache namespace."""

        return self.manager.clear(
            namespace=self.namespace
        )


class TaxonomyCache:
    """
    Cache normalized taxonomic records and taxonomy utility results.
    """

    def __init__(
        self,
        manager: CacheManager,
        *,
        namespace: str = "taxonomy",
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
            else CachePolicy(
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
            )
        )

    def record_key(
        self,
        *,
        provider: Any,
        provider_id: Any,
        assertion_hash: Any = "",
        taxonomy_version: Any = None,
    ) -> dict[str, Any]:
        """Build a key for one normalized provider taxon."""

        return {
            "kind": "record",
            "provider": normalize_key(
                provider
            ),
            "provider_id": normalize_space(
                provider_id
            ),
            "assertion_hash": normalize_key(
                assertion_hash
            ),
            "taxonomy_version": (
                canonicalize_value(
                    taxonomy_version
                )
            ),
        }

    def canonical_name_key(
        self,
        *,
        scientific_name: Any,
        authorship: Any = "",
        rank: Any = "",
        taxonomy_version: Any = None,
    ) -> dict[str, Any]:
        """Build a key for canonical scientific-name generation."""

        return {
            "kind": "canonical-name",
            "scientific_name": (
                normalize_space(
                    scientific_name
                )
            ),
            "authorship": normalize_space(
                authorship
            ),
            "rank": normalize_key(
                rank
            ),
            "taxonomy_version": (
                canonicalize_value(
                    taxonomy_version
                )
            ),
        }

    def lineage_key(
        self,
        *,
        provider: Any,
        provider_id: Any,
        lineage_hash: Any = "",
        taxonomy_version: Any = None,
    ) -> dict[str, Any]:
        """Build a key for normalized lineage data."""

        return {
            "kind": "lineage",
            "provider": normalize_key(
                provider
            ),
            "provider_id": normalize_space(
                provider_id
            ),
            "lineage_hash": normalize_key(
                lineage_hash
            ),
            "taxonomy_version": (
                canonicalize_value(
                    taxonomy_version
                )
            ),
        }

    def get_record(
        self,
        *,
        provider: Any,
        provider_id: Any,
        assertion_hash: Any = "",
        taxonomy_version: Any = None,
        allow_stale: bool = False,
    ) -> Any:
        """Read one normalized taxonomic record."""

        return self.manager.get(
            self.record_key(
                provider=provider,
                provider_id=provider_id,
                assertion_hash=(
                    assertion_hash
                ),
                taxonomy_version=(
                    taxonomy_version
                ),
            ),
            namespace=self.namespace,
            policy=self.policy,
            allow_stale=allow_stale,
        )

    def set_record(
        self,
        *,
        provider: Any,
        provider_id: Any,
        record: Any,
        assertion_hash: Any = "",
        taxonomy_version: Any = None,
        ttl_seconds: int | None = None,
    ) -> bool:
        """Store one normalized taxonomic record."""

        normalized_provider = (
            normalize_key(provider)
        )

        return self.manager.set(
            self.record_key(
                provider=normalized_provider,
                provider_id=provider_id,
                assertion_hash=(
                    assertion_hash
                ),
                taxonomy_version=(
                    taxonomy_version
                ),
            ),
            record,
            namespace=self.namespace,
            policy=self.policy,
            ttl_seconds=ttl_seconds,
            tags=(
                "taxonomy",
                "record",
                normalized_provider,
            ),
            source=(
                f"{normalized_provider}:"
                f"{normalize_space(provider_id)}"
            ),
        )

    def get_or_normalize(
        self,
        *,
        provider: Any,
        provider_id: Any,
        normalizer: Callable[[], Any],
        assertion_hash: Any = "",
        taxonomy_version: Any = None,
        allow_stale: bool = False,
        ttl_seconds: int | None = None,
    ) -> Any:
        """Return a normalized taxon or calculate and cache it."""

        normalized_provider = (
            normalize_key(provider)
        )

        return self.manager.get_or_set(
            self.record_key(
                provider=normalized_provider,
                provider_id=provider_id,
                assertion_hash=(
                    assertion_hash
                ),
                taxonomy_version=(
                    taxonomy_version
                ),
            ),
            normalizer,
            namespace=self.namespace,
            policy=self.policy,
            allow_stale=allow_stale,
            ttl_seconds=ttl_seconds,
            tags=(
                "taxonomy",
                "record",
                normalized_provider,
            ),
            source=(
                f"{normalized_provider}:"
                f"{normalize_space(provider_id)}"
            ),
        )

    def get_or_build_canonical_name(
        self,
        *,
        scientific_name: Any,
        builder: Callable[[], str],
        authorship: Any = "",
        rank: Any = "",
        taxonomy_version: Any = None,
    ) -> str:
        """Return a cached canonical scientific name."""

        result = self.manager.get_or_set(
            self.canonical_name_key(
                scientific_name=(
                    scientific_name
                ),
                authorship=authorship,
                rank=rank,
                taxonomy_version=(
                    taxonomy_version
                ),
            ),
            builder,
            namespace=self.namespace,
            policy=self.policy,
            tags=(
                "taxonomy",
                "canonical-name",
            ),
        )

        return str(
            result
            if result is not None
            else ""
        )

    def get_lineage(
        self,
        *,
        provider: Any,
        provider_id: Any,
        lineage_hash: Any = "",
        taxonomy_version: Any = None,
    ) -> Any:
        """Read one normalized lineage."""

        return self.manager.get(
            self.lineage_key(
                provider=provider,
                provider_id=provider_id,
                lineage_hash=lineage_hash,
                taxonomy_version=(
                    taxonomy_version
                ),
            ),
            namespace=self.namespace,
            policy=self.policy,
        )

    def set_lineage(
        self,
        *,
        provider: Any,
        provider_id: Any,
        lineage: Any,
        lineage_hash: Any = "",
        taxonomy_version: Any = None,
    ) -> bool:
        """Store one normalized lineage."""

        normalized_provider = (
            normalize_key(provider)
        )

        return self.manager.set(
            self.lineage_key(
                provider=normalized_provider,
                provider_id=provider_id,
                lineage_hash=lineage_hash,
                taxonomy_version=(
                    taxonomy_version
                ),
            ),
            lineage,
            namespace=self.namespace,
            policy=self.policy,
            tags=(
                "taxonomy",
                "lineage",
                normalized_provider,
            ),
            source=(
                f"{normalized_provider}:"
                f"{normalize_space(provider_id)}"
            ),
        )

    def invalidate_provider(
        self,
        provider: Any,
    ) -> int:
        """Invalidate normalized taxonomy data for one provider."""

        return self.manager.invalidate_tag(
            normalize_key(provider),
            namespace=self.namespace,
        )

    def clear(self) -> int:
        """Clear taxonomy cache data."""

        return self.manager.clear(
            namespace=self.namespace
        )


class SynonymCache:
    """
    Cache synonym lookup results and synonym lists for canonical taxa.
    """

    def __init__(
        self,
        manager: CacheManager,
        *,
        namespace: str = "synonyms",
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
            else CachePolicy(
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
            )
        )

    def lookup_key(
        self,
        *,
        synonym: Any,
        rank: Any = "",
        kingdom: Any = "",
        family: Any = "",
        genus: Any = "",
        provider: Any = "",
        generation: Any = None,
    ) -> dict[str, Any]:
        """Build a synonym-resolution cache key."""

        return {
            "kind": "lookup",
            "synonym": normalize_key(
                synonym
            ),
            "rank": normalize_key(
                rank
            ),
            "kingdom": normalize_key(
                kingdom
            ),
            "family": normalize_key(
                family
            ),
            "genus": normalize_key(
                genus
            ),
            "provider": normalize_key(
                provider
            ),
            "generation": (
                canonicalize_value(
                    generation
                )
            ),
        }

    def taxon_key(
        self,
        *,
        speciedex_id: Any,
        include_providers: bool = False,
        generation: Any = None,
    ) -> dict[str, Any]:
        """Build a canonical taxon synonym-list key."""

        return {
            "kind": "taxon",
            "speciedex_id": (
                normalize_space(
                    speciedex_id
                )
            ),
            "include_providers": bool(
                include_providers
            ),
            "generation": (
                canonicalize_value(
                    generation
                )
            ),
        }

    def get_or_lookup(
        self,
        *,
        synonym: Any,
        resolver: Callable[[], Any],
        rank: Any = "",
        kingdom: Any = "",
        family: Any = "",
        genus: Any = "",
        provider: Any = "",
        generation: Any = None,
    ) -> Any:
        """Return a synonym lookup result or execute the resolver."""

        return self.manager.get_or_set(
            self.lookup_key(
                synonym=synonym,
                rank=rank,
                kingdom=kingdom,
                family=family,
                genus=genus,
                provider=provider,
                generation=generation,
            ),
            resolver,
            namespace=self.namespace,
            policy=self.policy,
            tags=(
                "synonyms",
                "lookup",
            ),
        )

    def get_or_load_taxon_synonyms(
        self,
        *,
        speciedex_id: Any,
        loader: Callable[[], Any],
        include_providers: bool = False,
        generation: Any = None,
    ) -> Any:
        """Return cached synonyms for one canonical taxon."""

        return self.manager.get_or_set(
            self.taxon_key(
                speciedex_id=speciedex_id,
                include_providers=(
                    include_providers
                ),
                generation=generation,
            ),
            loader,
            namespace=self.namespace,
            policy=self.policy,
            tags=(
                "synonyms",
                "taxon",
            ),
            source=normalize_space(
                speciedex_id
            ),
        )

    def invalidate_synonym(
        self,
        *,
        synonym: Any,
        rank: Any = "",
        kingdom: Any = "",
        family: Any = "",
        genus: Any = "",
        provider: Any = "",
        generation: Any = None,
    ) -> bool:
        """Delete one synonym lookup."""

        return self.manager.delete(
            self.lookup_key(
                synonym=synonym,
                rank=rank,
                kingdom=kingdom,
                family=family,
                genus=genus,
                provider=provider,
                generation=generation,
            ),
            namespace=self.namespace,
        )

    def invalidate_taxon(
        self,
        speciedex_id: Any,
    ) -> int:
        """Invalidate taxon-synonym results associated with an identifier."""

        return self.manager.invalidate_source(
            normalize_space(
                speciedex_id
            ),
            namespace=self.namespace,
        )

    def clear(self) -> int:
        """Clear the synonym cache namespace."""

        return self.manager.clear(
            namespace=self.namespace
        )


class AuthorityCache:
    """
    Cache normalized nomenclatural authority parsing and comparisons.
    """

    def __init__(
        self,
        manager: CacheManager,
        *,
        namespace: str = "authority",
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
            else CachePolicy(
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
            )
        )

    def parse_key(
        self,
        *,
        authority: Any,
        registry_version: Any = None,
    ) -> dict[str, Any]:
        """Build an authority-parsing key."""

        return {
            "kind": "parse",
            "authority": normalize_space(
                authority
            ),
            "registry_version": (
                canonicalize_value(
                    registry_version
                )
            ),
        }

    def comparison_key(
        self,
        *,
        left: Any,
        right: Any,
        registry_version: Any = None,
        threshold: float = 0.85,
    ) -> dict[str, Any]:
        """Build an authority-comparison key."""

        normalized_pair = sorted(
            (
                normalize_space(left),
                normalize_space(right),
            )
        )

        return {
            "kind": "compare",
            "left": normalized_pair[0],
            "right": normalized_pair[1],
            "registry_version": (
                canonicalize_value(
                    registry_version
                )
            ),
            "threshold": round(
                float(threshold),
                8,
            ),
        }

    def get_or_parse(
        self,
        *,
        authority: Any,
        parser: Callable[[], Any],
        registry_version: Any = None,
    ) -> Any:
        """Return a parsed authority or invoke the parser."""

        return self.manager.get_or_set(
            self.parse_key(
                authority=authority,
                registry_version=(
                    registry_version
                ),
            ),
            parser,
            namespace=self.namespace,
            policy=self.policy,
            tags=(
                "authority",
                "parse",
            ),
        )

    def get_or_compare(
        self,
        *,
        left: Any,
        right: Any,
        comparer: Callable[[], Any],
        registry_version: Any = None,
        threshold: float = 0.85,
    ) -> Any:
        """Return a cached authority comparison."""

        return self.manager.get_or_set(
            self.comparison_key(
                left=left,
                right=right,
                registry_version=(
                    registry_version
                ),
                threshold=threshold,
            ),
            comparer,
            namespace=self.namespace,
            policy=self.policy,
            tags=(
                "authority",
                "compare",
            ),
        )

    def clear(self) -> int:
        """Clear authority cache data."""

        return self.manager.clear(
            namespace=self.namespace
        )


class LineageCache:
    """
    Cache lineage normalization, fingerprints, comparisons, and merge results.
    """

    def __init__(
        self,
        manager: CacheManager,
        *,
        namespace: str = "lineage",
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
            else CachePolicy(
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
            )
        )

    def normalized_key(
        self,
        lineage: Any,
        *,
        taxonomy_version: Any = None,
    ) -> dict[str, Any]:
        """Build a normalized-lineage cache key."""

        return {
            "kind": "normalize",
            "lineage": canonicalize_value(
                lineage
            ),
            "taxonomy_version": (
                canonicalize_value(
                    taxonomy_version
                )
            ),
        }

    def comparison_key(
        self,
        *,
        left: Any,
        right: Any,
        ranks: Sequence[Any] | None = None,
        weights: Mapping[
            Any,
            Any,
        ] | None = None,
        taxonomy_version: Any = None,
    ) -> dict[str, Any]:
        """Build a lineage-comparison key."""

        left_value = canonicalize_value(
            left
        )

        right_value = canonicalize_value(
            right
        )

        ordered_pair = sorted(
            (
                left_value,
                right_value,
            ),
            key=lambda value: json.dumps(
                value,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ),
        )

        return {
            "kind": "compare",
            "left": ordered_pair[0],
            "right": ordered_pair[1],
            "ranks": canonicalize_value(
                ranks
            ),
            "weights": canonicalize_value(
                weights
            ),
            "taxonomy_version": (
                canonicalize_value(
                    taxonomy_version
                )
            ),
        }

    def merge_key(
        self,
        *,
        left: Any,
        right: Any,
        prefer: str,
        taxonomy_version: Any = None,
    ) -> dict[str, Any]:
        """Build a lineage-merge key."""

        return {
            "kind": "merge",
            "left": canonicalize_value(
                left
            ),
            "right": canonicalize_value(
                right
            ),
            "prefer": normalize_key(
                prefer
            ),
            "taxonomy_version": (
                canonicalize_value(
                    taxonomy_version
                )
            ),
        }

    def get_or_normalize(
        self,
        *,
        lineage: Any,
        normalizer: Callable[[], Any],
        taxonomy_version: Any = None,
    ) -> Any:
        """Return normalized lineage data."""

        return self.manager.get_or_set(
            self.normalized_key(
                lineage,
                taxonomy_version=(
                    taxonomy_version
                ),
            ),
            normalizer,
            namespace=self.namespace,
            policy=self.policy,
            tags=(
                "lineage",
                "normalize",
            ),
        )

    def get_or_compare(
        self,
        *,
        left: Any,
        right: Any,
        comparer: Callable[[], Any],
        ranks: Sequence[Any] | None = None,
        weights: Mapping[
            Any,
            Any,
        ] | None = None,
        taxonomy_version: Any = None,
    ) -> Any:
        """Return a cached lineage comparison."""

        return self.manager.get_or_set(
            self.comparison_key(
                left=left,
                right=right,
                ranks=ranks,
                weights=weights,
                taxonomy_version=(
                    taxonomy_version
                ),
            ),
            comparer,
            namespace=self.namespace,
            policy=self.policy,
            tags=(
                "lineage",
                "compare",
            ),
        )

    def get_or_merge(
        self,
        *,
        left: Any,
        right: Any,
        merger: Callable[[], Any],
        prefer: str = "left",
        taxonomy_version: Any = None,
    ) -> Any:
        """Return a cached lineage merge result."""

        return self.manager.get_or_set(
            self.merge_key(
                left=left,
                right=right,
                prefer=prefer,
                taxonomy_version=(
                    taxonomy_version
                ),
            ),
            merger,
            namespace=self.namespace,
            policy=self.policy,
            tags=(
                "lineage",
                "merge",
            ),
        )

    def clear(self) -> int:
        """Clear lineage cache data."""

        return self.manager.clear(
            namespace=self.namespace
        )


@dataclass(slots=True)
class CachedBatch:
    """Serializable provider or processing batch."""

    records: list[Any]
    next_cursor: Any
    exhausted: bool
    requests: int = 0
    raw: int = 0
    created_at: str = field(
        default_factory=utc_now
    )
    metadata: dict[str, Any] = field(
        default_factory=dict
    )

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible batch description."""

        return {
            "records": list(
                self.records
            ),
            "next_cursor": (
                self.next_cursor
            ),
            "exhausted": self.exhausted,
            "requests": self.requests,
            "raw": self.raw,
            "created_at": self.created_at,
            "metadata": dict(
                self.metadata
            ),
        }


class BatchCache:
    """
    Cache provider pages and normalized ingestion batches.
    """

    def __init__(
        self,
        manager: CacheManager,
        *,
        namespace: str = "batches",
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
            else CachePolicy(
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
            )
        )

    def build_key(
        self,
        *,
        provider: Any,
        cursor: Any,
        batch_size: int,
        filters: Mapping[
            str,
            Any,
        ] | None = None,
        provider_version: Any = None,
        normalizer_version: Any = None,
    ) -> dict[str, Any]:
        """Build a deterministic batch cache key."""

        return {
            "provider": normalize_key(
                provider
            ),
            "cursor": normalize_space(
                cursor
            ),
            "batch_size": max(
                1,
                int(batch_size),
            ),
            "filters": canonicalize_value(
                filters or {}
            ),
            "provider_version": (
                canonicalize_value(
                    provider_version
                )
            ),
            "normalizer_version": (
                canonicalize_value(
                    normalizer_version
                )
            ),
        }

    def get(
        self,
        *,
        provider: Any,
        cursor: Any,
        batch_size: int,
        filters: Mapping[
            str,
            Any,
        ] | None = None,
        provider_version: Any = None,
        normalizer_version: Any = None,
        allow_stale: bool = False,
    ) -> CachedBatch | None:
        """Read one cached batch."""

        value = self.manager.get(
            self.build_key(
                provider=provider,
                cursor=cursor,
                batch_size=batch_size,
                filters=filters,
                provider_version=(
                    provider_version
                ),
                normalizer_version=(
                    normalizer_version
                ),
            ),
            namespace=self.namespace,
            policy=self.policy,
            allow_stale=allow_stale,
        )

        if isinstance(
            value,
            CachedBatch,
        ):
            return value

        if isinstance(
            value,
            Mapping,
        ):
            records = value.get(
                "records",
                [],
            )

            if not isinstance(
                records,
                list,
            ):
                records = list(records)

            return CachedBatch(
                records=records,
                next_cursor=value.get(
                    "next_cursor"
                ),
                exhausted=bool(
                    value.get(
                        "exhausted",
                        False,
                    )
                ),
                requests=max(
                    0,
                    safe_int(
                        value.get(
                            "requests",
                            0,
                        )
                    ),
                ),
                raw=max(
                    0,
                    safe_int(
                        value.get(
                            "raw",
                            len(records),
                        )
                    ),
                ),
                created_at=normalize_space(
                    value.get(
                        "created_at",
                        utc_now(),
                    )
                ),
                metadata=(
                    dict(
                        value.get(
                            "metadata",
                            {},
                        )
                    )
                    if isinstance(
                        value.get(
                            "metadata",
                            {},
                        ),
                        Mapping,
                    )
                    else {}
                ),
            )

        return None

    def set(
        self,
        *,
        provider: Any,
        cursor: Any,
        batch_size: int,
        records: Iterable[Any],
        next_cursor: Any,
        exhausted: bool,
        requests: int = 0,
        raw: int | None = None,
        filters: Mapping[
            str,
            Any,
        ] | None = None,
        provider_version: Any = None,
        normalizer_version: Any = None,
        metadata: Mapping[
            str,
            Any,
        ] | None = None,
        ttl_seconds: int | None = None,
    ) -> bool:
        """Store one normalized batch."""

        record_values = list(
            records
        )

        normalized_provider = (
            normalize_key(provider)
        )

        batch = CachedBatch(
            records=record_values,
            next_cursor=next_cursor,
            exhausted=bool(exhausted),
            requests=max(
                0,
                int(requests),
            ),
            raw=(
                max(
                    0,
                    int(raw),
                )
                if raw is not None
                else len(record_values)
            ),
            metadata=dict(
                metadata or {}
            ),
        )

        return self.manager.set(
            self.build_key(
                provider=normalized_provider,
                cursor=cursor,
                batch_size=batch_size,
                filters=filters,
                provider_version=(
                    provider_version
                ),
                normalizer_version=(
                    normalizer_version
                ),
            ),
            batch,
            namespace=self.namespace,
            policy=self.policy,
            ttl_seconds=ttl_seconds,
            tags=(
                "batch",
                normalized_provider,
            ),
            source=normalized_provider,
            extra={
                "cursor": (
                    normalize_space(
                        cursor
                    )
                ),
                "batch_size": max(
                    1,
                    int(batch_size),
                ),
                "record_count": len(
                    record_values
                ),
            },
        )

    def invalidate_provider(
        self,
        provider: Any,
    ) -> int:
        """Invalidate all batches for one provider."""

        return self.manager.invalidate_tag(
            normalize_key(provider),
            namespace=self.namespace,
        )

    def clear(self) -> int:
        """Clear all cached batches."""

        return self.manager.clear(
            namespace=self.namespace
        )
