#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/cache_specialized.py

Statistics, manifest, history, and deduplication cache facades.

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

class StatisticsCache:
    """
    Cache generated archive statistics and expensive aggregate queries.
    """

    def __init__(
        self,
        manager: CacheManager,
        *,
        namespace: str = "statistics",
        policy: CachePolicy | None = None,
    ) -> None:
        self.manager = manager
        self.namespace = normalize_namespace(
            namespace
        )

        self.policy = (
            policy
            if policy is not None
            else CachePolicy(
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
            )
        )

    def build_key(
        self,
        *,
        name: Any,
        parameters: Mapping[
            str,
            Any,
        ] | None = None,
        generation: Any = None,
    ) -> dict[str, Any]:
        """Build a deterministic statistics cache key."""

        normalized_name = normalize_key(
            name
        )

        if not normalized_name:
            raise CacheKeyError(
                "Statistics cache key requires "
                "a name."
            )

        return {
            "name": normalized_name,
            "parameters": canonicalize_value(
                parameters or {}
            ),
            "generation": canonicalize_value(
                generation
            ),
        }

    def get(
        self,
        *,
        name: Any,
        parameters: Mapping[
            str,
            Any,
        ] | None = None,
        generation: Any = None,
        allow_stale: bool = False,
    ) -> Any:
        """Return one cached statistics result."""

        return self.manager.get(
            self.build_key(
                name=name,
                parameters=parameters,
                generation=generation,
            ),
            namespace=self.namespace,
            policy=self.policy,
            allow_stale=allow_stale,
        )

    def set(
        self,
        *,
        name: Any,
        value: Any,
        parameters: Mapping[
            str,
            Any,
        ] | None = None,
        generation: Any = None,
        ttl_seconds: int | None = None,
    ) -> bool:
        """Store one statistics result."""

        normalized_name = normalize_key(
            name
        )

        return self.manager.set(
            self.build_key(
                name=normalized_name,
                parameters=parameters,
                generation=generation,
            ),
            value,
            namespace=self.namespace,
            policy=self.policy,
            ttl_seconds=ttl_seconds,
            tags=(
                "statistics",
                normalized_name,
            ),
            source=normalized_name,
        )

    def get_or_calculate(
        self,
        *,
        name: Any,
        calculator: Callable[
            [],
            Any,
        ],
        parameters: Mapping[
            str,
            Any,
        ] | None = None,
        generation: Any = None,
        allow_stale: bool = False,
        ttl_seconds: int | None = None,
    ) -> Any:
        """Return cached statistics or execute the calculator."""

        normalized_name = normalize_key(
            name
        )

        return self.manager.get_or_set(
            self.build_key(
                name=normalized_name,
                parameters=parameters,
                generation=generation,
            ),
            calculator,
            namespace=self.namespace,
            policy=self.policy,
            allow_stale=allow_stale,
            ttl_seconds=ttl_seconds,
            tags=(
                "statistics",
                normalized_name,
            ),
            source=normalized_name,
        )

    def invalidate(
        self,
        name: Any,
    ) -> int:
        """Invalidate one statistics category."""

        return self.manager.invalidate_tag(
            normalize_key(name),
            namespace=self.namespace,
        )

    def clear(self) -> int:
        """Clear all cached statistics."""

        return self.manager.clear(
            namespace=self.namespace
        )


class ManifestCache:
    """
    Cache parsed manifests and derived manifest summaries.

    This cache does not replace ManifestManager. ManifestManager remains the
    persistence owner. This facade avoids repeated parsing and repeated
    derivation of immutable manifest views.
    """

    def __init__(
        self,
        manager: CacheManager,
        *,
        namespace: str = "manifest",
        policy: CachePolicy | None = None,
    ) -> None:
        self.manager = manager
        self.namespace = normalize_namespace(
            namespace
        )

        self.policy = (
            policy
            if policy is not None
            else CachePolicy(
                ttl_seconds=5 * 60,
                stale_ttl_seconds=0,
                memory=True,
                disk=False,
                serializer=SERIALIZER_PICKLE,
                compression=COMPRESSION_NONE,
                cache_none=False,
                verify_hash=False,
            )
        )

    def build_key(
        self,
        *,
        path: Path,
        modified_ns: int | None = None,
        view: str = "full",
    ) -> dict[str, Any]:
        """Build a manifest cache key."""

        source = Path(path)

        if modified_ns is None:
            try:
                modified_ns = (
                    source.stat().st_mtime_ns
                )
            except OSError:
                modified_ns = 0

        return {
            "path": source.resolve().as_posix(),
            "modified_ns": int(
                modified_ns
            ),
            "view": normalize_key(
                view
            ),
        }

    def get_or_load(
        self,
        path: Path,
        *,
        loader: Callable[
            [],
            Any,
        ] | None = None,
        view: str = "full",
    ) -> Any:
        """Return a parsed manifest or read it from disk."""

        source = Path(path)

        def default_loader() -> Any:
            try:
                return json.loads(
                    source.read_text(
                        encoding="utf-8",
                    )
                )
            except OSError as error:
                raise CacheError(
                    "Unable to read manifest "
                    f"{source}: {error}"
                ) from error
            except json.JSONDecodeError as error:
                raise CacheIntegrityError(
                    "Invalid manifest JSON in "
                    f"{source}: {error}"
                ) from error

        return self.manager.get_or_set(
            self.build_key(
                path=source,
                view=view,
            ),
            (
                loader
                if loader is not None
                else default_loader
            ),
            namespace=self.namespace,
            policy=self.policy,
            tags=(
                "manifest",
                normalize_key(view),
            ),
            source=source.as_posix(),
        )

    def invalidate_path(
        self,
        path: Path,
    ) -> int:
        """Invalidate cached views for one manifest path."""

        return self.manager.invalidate_source(
            Path(path).as_posix(),
            namespace=self.namespace,
        )

    def clear(self) -> int:
        """Clear manifest cache data."""

        return self.manager.clear(
            namespace=self.namespace
        )


class HistoryCache:
    """
    Cache retained statistics history and provider-run history.
    """

    def __init__(
        self,
        manager: CacheManager,
        *,
        namespace: str = "history",
        policy: CachePolicy | None = None,
    ) -> None:
        self.manager = manager
        self.namespace = normalize_namespace(
            namespace
        )

        self.policy = (
            policy
            if policy is not None
            else CachePolicy(
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
            )
        )

    def file_key(
        self,
        *,
        path: Path,
        category: str,
    ) -> dict[str, Any]:
        """Build a history-file cache key."""

        source = Path(path)

        try:
            stat = source.stat()

            modified_ns = (
                stat.st_mtime_ns
            )

            size_bytes = stat.st_size

        except OSError:
            modified_ns = 0
            size_bytes = 0

        return {
            "category": normalize_key(
                category
            ),
            "path": source.resolve().as_posix(),
            "modified_ns": modified_ns,
            "size_bytes": size_bytes,
        }

    def get_or_load(
        self,
        *,
        path: Path,
        category: str,
        loader: Callable[
            [],
            Any,
        ],
    ) -> Any:
        """Return cached history data or invoke a loader."""

        source = Path(path)

        return self.manager.get_or_set(
            self.file_key(
                path=source,
                category=category,
            ),
            loader,
            namespace=self.namespace,
            policy=self.policy,
            tags=(
                "history",
                normalize_key(category),
            ),
            source=source.as_posix(),
        )

    def invalidate_path(
        self,
        path: Path,
    ) -> int:
        """Invalidate history data associated with one file."""

        return self.manager.invalidate_source(
            Path(path).as_posix(),
            namespace=self.namespace,
        )

    def clear(self) -> int:
        """Clear history cache data."""

        return self.manager.clear(
            namespace=self.namespace
        )


class DeduplicationCache:
    """
    Cache duplicate candidate discovery and pairwise duplicate scores.
    """

    def __init__(
        self,
        manager: CacheManager,
        *,
        namespace: str = "deduplication",
        policy: CachePolicy | None = None,
    ) -> None:
        self.manager = manager
        self.namespace = normalize_namespace(
            namespace
        )

        self.policy = (
            policy
            if policy is not None
            else CachePolicy(
                ttl_seconds=30 * 60,
                stale_ttl_seconds=0,
                memory=True,
                disk=False,
                serializer=SERIALIZER_PICKLE,
                compression=COMPRESSION_NONE,
                cache_none=True,
                verify_hash=False,
            )
        )

    def candidate_key(
        self,
        *,
        signature: Any,
        generation: Any = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        """Build a duplicate candidate cache key."""

        return {
            "kind": "candidates",
            "signature": canonicalize_value(
                signature
            ),
            "generation": canonicalize_value(
                generation
            ),
            "limit": (
                int(limit)
                if limit is not None
                else None
            ),
        }

    def comparison_key(
        self,
        *,
        left: Any,
        right: Any,
        policy_version: Any = None,
    ) -> dict[str, Any]:
        """Build a symmetric duplicate-comparison key."""

        left_value = canonicalize_value(
            left
        )

        right_value = canonicalize_value(
            right
        )

        pair = sorted(
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
            "kind": "comparison",
            "left": pair[0],
            "right": pair[1],
            "policy_version": (
                canonicalize_value(
                    policy_version
                )
            ),
        }

    def get_or_find_candidates(
        self,
        *,
        signature: Any,
        finder: Callable[[], Any],
        generation: Any = None,
        limit: int | None = None,
    ) -> Any:
        """Return cached duplicate candidates."""

        return self.manager.get_or_set(
            self.candidate_key(
                signature=signature,
                generation=generation,
                limit=limit,
            ),
            finder,
            namespace=self.namespace,
            policy=self.policy,
            tags=(
                "deduplication",
                "candidates",
            ),
        )

    def get_or_compare(
        self,
        *,
        left: Any,
        right: Any,
        comparer: Callable[[], Any],
        policy_version: Any = None,
    ) -> Any:
        """Return a cached duplicate comparison."""

        return self.manager.get_or_set(
            self.comparison_key(
                left=left,
                right=right,
                policy_version=(
                    policy_version
                ),
            ),
            comparer,
            namespace=self.namespace,
            policy=self.policy,
            tags=(
                "deduplication",
                "comparison",
            ),
        )

    def clear(self) -> int:
        """Clear duplicate-analysis cache data."""

        return self.manager.clear(
            namespace=self.namespace
        )
