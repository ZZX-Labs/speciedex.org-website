#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/cache_http.py

HTTP response, SQLite lookup, and reconciliation cache facades.

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

class HTTPResponseCacheValue:
    """Serializable cached HTTP response."""

    status_code: int
    headers: dict[str, str]
    body: bytes
    url: str
    method: str
    retrieved_at: str
    encoding: str = "utf-8"

    def json(self) -> Any:
        """Decode the response body as JSON."""

        return json.loads(
            self.body.decode(
                self.encoding
                or "utf-8"
            )
        )

    @property
    def text(self) -> str:
        """Decode the response body as text."""

        return self.body.decode(
            self.encoding
            or "utf-8",
            errors="replace",
        )

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible description."""

        return {
            "status_code": (
                self.status_code
            ),
            "headers": dict(
                self.headers
            ),
            "body_bytes": len(
                self.body
            ),
            "url": self.url,
            "method": self.method,
            "retrieved_at": (
                self.retrieved_at
            ),
            "encoding": self.encoding,
        }


class HTTPResponseCache:
    """
    HTTP response cache facade.

    This class does not perform network requests. It builds deterministic keys,
    stores response payloads, and exposes conditional-request headers.
    """

    def __init__(
        self,
        manager: CacheManager,
        *,
        namespace: str = "http",
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
                ttl_seconds=60 * 60,
                stale_ttl_seconds=(
                    24 * 60 * 60
                ),
                memory=True,
                disk=True,
                serializer=(
                    SERIALIZER_PICKLE
                ),
                compression=(
                    COMPRESSION_GZIP
                ),
                cache_none=False,
                verify_hash=True,
            )
        )

    def build_key(
        self,
        *,
        method: str,
        url: str,
        params: Mapping[
            str,
            Any,
        ] | None = None,
        headers: Mapping[
            str,
            Any,
        ] | None = None,
        body: Any = None,
        vary_headers: Sequence[str] = (
            "accept",
            "content-type",
            "authorization",
        ),
    ) -> dict[str, Any]:
        """Build a deterministic HTTP cache key."""

        normalized_headers = {
            normalize_key(key): (
                normalize_space(value)
            )
            for key, value in (
                headers or {}
            ).items()
        }

        selected_headers = {
            normalize_key(header): (
                normalized_headers.get(
                    normalize_key(
                        header
                    ),
                    "",
                )
            )
            for header in vary_headers
        }

        return {
            "method": normalize_key(
                method
            ).upper(),
            "url": normalize_space(
                url
            ),
            "params": dict(
                sorted(
                    (
                        str(key),
                        canonicalize_value(
                            value
                        ),
                    )
                    for key, value
                    in (
                        params or {}
                    ).items()
                )
            ),
            "headers": selected_headers,
            "body": canonicalize_value(
                body
            ),
        }

    def get(
        self,
        *,
        method: str,
        url: str,
        params: Mapping[
            str,
            Any,
        ] | None = None,
        headers: Mapping[
            str,
            Any,
        ] | None = None,
        body: Any = None,
        allow_stale: bool = False,
    ) -> HTTPResponseCacheValue | None:
        """Read one cached HTTP response."""

        key_value = self.build_key(
            method=method,
            url=url,
            params=params,
            headers=headers,
            body=body,
        )

        value = self.manager.get(
            key_value,
            namespace=self.namespace,
            policy=self.policy,
            allow_stale=allow_stale,
        )

        if isinstance(
            value,
            HTTPResponseCacheValue,
        ):
            return value

        if isinstance(
            value,
            Mapping,
        ):
            try:
                raw_body = value.get(
                    "body",
                    b"",
                )

                if isinstance(
                    raw_body,
                    str,
                ):
                    raw_body = raw_body.encode(
                        value.get(
                            "encoding",
                            "utf-8",
                        )
                        or "utf-8"
                    )

                return (
                    HTTPResponseCacheValue(
                        status_code=int(
                            value.get(
                                "status_code",
                                0,
                            )
                        ),
                        headers={
                            str(key): str(item)
                            for key, item
                            in dict(
                                value.get(
                                    "headers",
                                    {},
                                )
                            ).items()
                        },
                        body=bytes(
                            raw_body
                        ),
                        url=str(
                            value.get(
                                "url",
                                url,
                            )
                        ),
                        method=str(
                            value.get(
                                "method",
                                method,
                            )
                        ),
                        retrieved_at=str(
                            value.get(
                                "retrieved_at",
                                "",
                            )
                        ),
                        encoding=str(
                            value.get(
                                "encoding",
                                "utf-8",
                            )
                        ),
                    )
                )

            except (
                TypeError,
                ValueError,
            ):
                return None

        return None

    def set(
        self,
        *,
        method: str,
        url: str,
        status_code: int,
        response_headers: Mapping[
            str,
            Any,
        ],
        body: bytes,
        params: Mapping[
            str,
            Any,
        ] | None = None,
        request_headers: Mapping[
            str,
            Any,
        ] | None = None,
        request_body: Any = None,
        encoding: str = "utf-8",
        ttl_seconds: int | None = None,
        stale_ttl_seconds: int | None = None,
    ) -> bool:
        """Store one HTTP response."""

        key_value = self.build_key(
            method=method,
            url=url,
            params=params,
            headers=request_headers,
            body=request_body,
        )

        normalized_response_headers = {
            normalize_key(key): (
                normalize_space(value)
            )
            for key, value
            in response_headers.items()
        }

        cache_value = (
            HTTPResponseCacheValue(
                status_code=int(
                    status_code
                ),
                headers={
                    str(key): str(value)
                    for key, value
                    in response_headers.items()
                },
                body=bytes(body),
                url=normalize_space(
                    url
                ),
                method=normalize_key(
                    method
                ).upper(),
                retrieved_at=utc_now(),
                encoding=(
                    normalize_space(
                        encoding
                    )
                    or "utf-8"
                ),
            )
        )

        return self.manager.set(
            key_value,
            cache_value,
            namespace=self.namespace,
            policy=self.policy,
            ttl_seconds=ttl_seconds,
            stale_ttl_seconds=(
                stale_ttl_seconds
            ),
            tags=(
                "http",
                normalize_key(
                    method
                ),
            ),
            source=normalize_space(
                url
            ),
            content_type=(
                normalized_response_headers
                .get(
                    "content-type",
                    "",
                )
            ),
            etag=(
                normalized_response_headers
                .get(
                    "etag",
                    "",
                )
            ),
            last_modified=(
                normalized_response_headers
                .get(
                    "last-modified",
                    "",
                )
            ),
            status_code=status_code,
            extra={
                "cache_control": (
                    normalized_response_headers
                    .get(
                        "cache-control",
                        "",
                    )
                ),
                "expires": (
                    normalized_response_headers
                    .get(
                        "expires",
                        "",
                    )
                ),
            },
        )

    def conditional_headers(
        self,
        *,
        method: str,
        url: str,
        params: Mapping[
            str,
            Any,
        ] | None = None,
        headers: Mapping[
            str,
            Any,
        ] | None = None,
        body: Any = None,
    ) -> dict[str, str]:
        """Return If-None-Match and If-Modified-Since headers."""

        key_value = self.build_key(
            method=method,
            url=url,
            params=params,
            headers=headers,
            body=body,
        )

        metadata = self.manager.metadata(
            key_value,
            namespace=self.namespace,
        )

        if metadata is None:
            return {}

        result: dict[str, str] = {}

        if metadata.etag:
            result[
                "If-None-Match"
            ] = metadata.etag

        if metadata.last_modified:
            result[
                "If-Modified-Since"
            ] = metadata.last_modified

        return result

    def refresh_not_modified(
        self,
        *,
        method: str,
        url: str,
        params: Mapping[
            str,
            Any,
        ] | None = None,
        headers: Mapping[
            str,
            Any,
        ] | None = None,
        body: Any = None,
        ttl_seconds: int | None = None,
        stale_ttl_seconds: int | None = None,
    ) -> bool:
        """Refresh TTL after an HTTP 304 response."""

        key_value = self.build_key(
            method=method,
            url=url,
            params=params,
            headers=headers,
            body=body,
        )

        normalized_namespace = (
            self.namespace
        )

        _canonical_key, key_digest = (
            cache_key(
                key_value,
                namespace=(
                    normalized_namespace
                ),
            )
        )

        active_ttl = (
            self.policy.ttl_seconds
            if ttl_seconds is None
            else max(
                0,
                int(ttl_seconds),
            )
        )

        active_stale = (
            self.policy.stale_ttl_seconds
            if stale_ttl_seconds
            is None
            else max(
                0,
                int(
                    stale_ttl_seconds
                ),
            )
        )

        touched = self.manager.disk.touch(
            normalized_namespace,
            key_digest,
            extend_ttl_seconds=(
                active_ttl
            ),
            extend_stale_seconds=(
                active_stale
            ),
        )

        if touched:
            self.manager.memory.delete(
                normalized_namespace,
                key_digest,
            )

        return touched

    def delete(
        self,
        *,
        method: str,
        url: str,
        params: Mapping[
            str,
            Any,
        ] | None = None,
        headers: Mapping[
            str,
            Any,
        ] | None = None,
        body: Any = None,
    ) -> bool:
        """Delete one cached HTTP response."""

        key_value = self.build_key(
            method=method,
            url=url,
            params=params,
            headers=headers,
            body=body,
        )

        return self.manager.delete(
            key_value,
            namespace=self.namespace,
        )


class SQLiteLookupCache:
    """
    Cache facade for rebuildable SQLite lookup results.
    """

    def __init__(
        self,
        manager: CacheManager,
        *,
        namespace: str = "sqlite",
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
                ttl_seconds=15 * 60,
                stale_ttl_seconds=0,
                memory=True,
                disk=False,
                serializer=(
                    SERIALIZER_PICKLE
                ),
                compression=(
                    COMPRESSION_NONE
                ),
                cache_none=True,
                verify_hash=False,
            )
        )

    def query_key(
        self,
        *,
        operation: str,
        parameters: Mapping[
            str,
            Any,
        ] | Sequence[Any] | None = None,
        generation: Any = None,
    ) -> dict[str, Any]:
        """Build a deterministic lookup key."""

        return {
            "operation": normalize_key(
                operation
            ),
            "parameters": (
                canonicalize_value(
                    parameters
                )
            ),
            "generation": (
                canonicalize_value(
                    generation
                )
            ),
        }

    def get_or_query(
        self,
        *,
        operation: str,
        parameters: Mapping[
            str,
            Any,
        ] | Sequence[Any] | None,
        query: Callable[[], Any],
        generation: Any = None,
        ttl_seconds: int | None = None,
    ) -> Any:
        """Return a cached query result or execute the query."""

        key_value = self.query_key(
            operation=operation,
            parameters=parameters,
            generation=generation,
        )

        return self.manager.get_or_set(
            key_value,
            query,
            namespace=self.namespace,
            policy=self.policy,
            ttl_seconds=ttl_seconds,
            tags=(
                "sqlite",
                normalize_key(
                    operation
                ),
            ),
            source=normalize_key(
                operation
            ),
        )

    def invalidate_operation(
        self,
        operation: str,
    ) -> int:
        """Invalidate entries associated with an operation."""

        return self.manager.invalidate_tag(
            normalize_key(
                operation
            ),
            namespace=self.namespace,
        )

    def clear(self) -> int:
        """Clear the SQLite lookup namespace."""

        return self.manager.clear(
            namespace=self.namespace
        )


class ReconciliationCache:
    """
    Cache facade for identity, source, synonym, and candidate lookups.
    """

    def __init__(
        self,
        manager: CacheManager,
        *,
        namespace: str = "reconciliation",
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
                stale_ttl_seconds=0,
                memory=True,
                disk=False,
                serializer=(
                    SERIALIZER_PICKLE
                ),
                compression=(
                    COMPRESSION_NONE
                ),
                cache_none=True,
                verify_hash=False,
            )
        )

    def source_key(
        self,
        provider: Any,
        provider_id: Any,
        *,
        generation: Any = None,
    ) -> dict[str, Any]:
        """Build a source-identifier lookup key."""

        return {
            "kind": "source",
            "provider": normalize_key(
                provider
            ),
            "provider_id": normalize_space(
                provider_id
            ),
            "generation": (
                canonicalize_value(
                    generation
                )
            ),
        }

    def identity_key(
        self,
        identity_key_value: Any,
        *,
        generation: Any = None,
    ) -> dict[str, Any]:
        """Build an identity lookup key."""

        return {
            "kind": "identity",
            "identity_key": normalize_key(
                identity_key_value
            ),
            "generation": (
                canonicalize_value(
                    generation
                )
            ),
        }

    def synonym_key(
        self,
        synonym: Any,
        *,
        generation: Any = None,
    ) -> dict[str, Any]:
        """Build a synonym lookup key."""

        return {
            "kind": "synonym",
            "synonym": normalize_key(
                synonym
            ),
            "generation": (
                canonicalize_value(
                    generation
                )
            ),
        }

    def candidates_key(
        self,
        *,
        canonical_name: Any,
        rank: Any,
        kingdom: Any = "",
        family: Any = "",
        genus: Any = "",
        generation: Any = None,
    ) -> dict[str, Any]:
        """Build a weighted-candidate lookup key."""

        return {
            "kind": "candidates",
            "canonical_name": (
                normalize_key(
                    canonical_name
                )
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
            "generation": (
                canonicalize_value(
                    generation
                )
            ),
        }

    def get_or_resolve(
        self,
        key_value: Mapping[str, Any],
        resolver: Callable[[], Any],
    ) -> Any:
        """Return a cached reconciliation result or resolve it."""

        return self.manager.get_or_set(
            key_value,
            resolver,
            namespace=self.namespace,
            policy=self.policy,
            tags=(
                "reconciliation",
                normalize_key(
                    key_value.get(
                        "kind",
                        "lookup",
                    )
                ),
            ),
            source=normalize_key(
                key_value.get(
                    "kind",
                    "lookup",
                )
            ),
        )

    def invalidate_kind(
        self,
        kind: str,
    ) -> int:
        """Invalidate one reconciliation lookup category."""

        return self.manager.invalidate_tag(
            normalize_key(kind),
            namespace=self.namespace,
        )

    def clear(self) -> int:
        """Clear all reconciliation lookups."""

        return self.manager.clear(
            namespace=self.namespace
        )
