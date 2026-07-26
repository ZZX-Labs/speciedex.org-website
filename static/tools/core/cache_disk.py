#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/cache_disk.py

Persistent sharded disk cache storage, verification, pruning, and metadata.

This module is an internal component of the public cache.py compatibility
wrapper. Import public cache APIs from static.tools.core.cache.

Copyright (c) 2026 ZZX-Laboratories
Licensed under the MIT License.
"""

from __future__ import annotations

try:
    from .cache_common import *
    from .cache_memory import CacheFileLock
except ImportError:  # Direct-module compatibility.
    from cache_common import *
    from cache_memory import CacheFileLock

class PersistentDiskCache:
    """
    Persistent namespace-aware disk cache.

    Each entry is stored beneath:

        <root>/<namespace>/<aa>/<bb>/<key_hash>/

    containing:

        metadata.json
        payload.cache

    or:

        payload.cache.gz

    The first four hash characters distribute entries across subdirectories.
    """

    def __init__(
        self,
        root: Path,
        *,
        maximum_entries: int = (
            DEFAULT_DISK_MAX_ENTRIES
        ),
        maximum_bytes: int = (
            DEFAULT_DISK_MAX_BYTES
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
        statistics: CacheStatistics | None = None,
    ) -> None:
        self.root = Path(root)

        self.maximum_entries = max(
            0,
            int(maximum_entries),
        )

        self.maximum_bytes = max(
            0,
            int(maximum_bytes),
        )

        self.lock_timeout_seconds = max(
            0.0,
            float(lock_timeout_seconds),
        )

        self.lock_poll_seconds = max(
            0.01,
            float(lock_poll_seconds),
        )

        self.stale_lock_seconds = max(
            1.0,
            float(stale_lock_seconds),
        )

        self.statistics = (
            statistics
            if statistics is not None
            else CacheStatistics()
        )

        self.root.mkdir(
            parents=True,
            exist_ok=True,
            mode=DEFAULT_DIRECTORY_MODE,
        )

        self._thread_lock = (
            threading.RLock()
        )

    def paths(
        self,
        namespace: str,
        key_hash_value: str,
        *,
        compression: str = (
            COMPRESSION_NONE
        ),
    ) -> CachePaths:
        """Return persistent paths for one cache entry."""

        normalized_namespace = (
            normalize_namespace(
                namespace
            )
        )

        normalized_hash = normalize_key(
            key_hash_value
        )

        if (
            len(normalized_hash) < 4
            or any(
                character
                not in "0123456789abcdef"
                for character
                in normalized_hash
            )
        ):
            raise CacheKeyError(
                "Persistent cache key hash must be "
                "a lowercase hexadecimal digest."
            )

        namespace_root = (
            self.root
            / normalized_namespace
        )

        entry_root = (
            namespace_root
            / normalized_hash[:2]
            / normalized_hash[2:4]
            / normalized_hash
        )

        normalized_compression = (
            normalize_key(
                compression
            )
        )

        if (
            normalized_compression
            == COMPRESSION_GZIP
        ):
            payload_name = (
                "payload"
                + CACHE_COMPRESSED_SUFFIX
            )
        else:
            payload_name = (
                "payload"
                + CACHE_FILE_SUFFIX
            )

        return CachePaths(
            namespace_root=namespace_root,
            entry_root=entry_root,
            payload_path=(
                entry_root
                / payload_name
            ),
            metadata_path=(
                entry_root
                / "metadata.json"
            ),
            lock_path=(
                entry_root
                / (
                    normalized_hash
                    + CACHE_LOCK_SUFFIX
                )
            ),
        )

    def set(
        self,
        *,
        namespace: str,
        key: str,
        key_hash_value: str,
        value: Any,
        policy: CachePolicy,
        tags: Iterable[str] | None = None,
        source: str = "",
        content_type: str = "",
        etag: str = "",
        last_modified: str = "",
        status_code: int | None = None,
        extra: Mapping[str, Any] | None = None,
        created_at: float | None = None,
    ) -> CacheEntryMetadata:
        """Serialize and persist one cache entry."""

        if not policy.disk:
            raise CacheConfigurationError(
                "Persistent cache write requested "
                "with disk caching disabled."
            )

        if (
            value is None
            and not policy.cache_none
        ):
            raise CacheSerializationError(
                "None values are disabled by "
                "the active cache policy."
            )

        serialized = serialize_value(
            value,
            serializer=policy.serializer,
        )

        digest = payload_hash(
            serialized
        )

        stored_payload, compression = (
            compress_payload(
                serialized,
                compression=(
                    policy.compression
                ),
                threshold=(
                    policy
                    .compress_above_bytes
                ),
            )
        )

        current_time = time.time()

        creation_time = (
            float(created_at)
            if created_at is not None
            else current_time
        )

        expires_at = (
            creation_time
            + policy.ttl_seconds
            if policy.ttl_seconds > 0
            else None
        )

        stale_until = (
            (
                expires_at
                + policy.stale_ttl_seconds
            )
            if (
                expires_at is not None
                and policy.stale_ttl_seconds
                > 0
            )
            else expires_at
        )

        metadata = CacheEntryMetadata(
            schema_version=(
                CACHE_SCHEMA_VERSION
            ),
            namespace=normalize_namespace(
                namespace
            ),
            key=key,
            key_hash=normalize_key(
                key_hash_value
            ),
            created_at=creation_time,
            updated_at=current_time,
            accessed_at=current_time,
            expires_at=expires_at,
            stale_until=stale_until,
            serializer=policy.serializer,
            compression=compression,
            payload_hash=digest,
            payload_bytes=len(
                serialized
            ),
            stored_bytes=len(
                stored_payload
            ),
            hits=0,
            tags=sorted(
                {
                    normalize_key(tag)
                    for tag in (
                        tags or []
                    )
                    if normalize_key(tag)
                }
            ),
            source=normalize_space(
                source
            ),
            content_type=normalize_space(
                content_type
            ),
            etag=normalize_space(
                etag
            ),
            last_modified=normalize_space(
                last_modified
            ),
            status_code=(
                int(status_code)
                if status_code is not None
                else None
            ),
            extra=dict(
                extra or {}
            ),
        )

        paths = self.paths(
            metadata.namespace,
            metadata.key_hash,
            compression=(
                metadata.compression
            ),
        )

        alternate_paths = self.paths(
            metadata.namespace,
            metadata.key_hash,
            compression=(
                COMPRESSION_GZIP
                if metadata.compression
                == COMPRESSION_NONE
                else COMPRESSION_NONE
            ),
        )

        lock = CacheFileLock(
            paths.lock_path,
            timeout_seconds=(
                self.lock_timeout_seconds
            ),
            poll_seconds=(
                self.lock_poll_seconds
            ),
            stale_seconds=(
                self.stale_lock_seconds
            ),
            statistics=self.statistics,
        )

        with self._thread_lock:
            with lock:
                paths.entry_root.mkdir(
                    parents=True,
                    exist_ok=True,
                    mode=(
                        DEFAULT_DIRECTORY_MODE
                    ),
                )

                atomic_write_bytes(
                    paths.payload_path,
                    stored_payload,
                )

                atomic_write_json(
                    paths.metadata_path,
                    metadata.to_dict(),
                )

                if (
                    alternate_paths.payload_path
                    != paths.payload_path
                ):
                    alternate_paths.payload_path.unlink(
                        missing_ok=True
                    )

        self.statistics.writes += 1
        self.statistics.bytes_written += len(
            stored_payload
        )

        return metadata

    def get(
        self,
        namespace: str,
        key_hash_value: str,
        *,
        allow_stale: bool = False,
        verify_payload: bool = True,
        touch: bool = True,
    ) -> CacheEntry[Any] | None:
        """Read and decode one persistent cache entry."""

        normalized_namespace = (
            normalize_namespace(
                namespace
            )
        )

        normalized_hash = normalize_key(
            key_hash_value
        )

        metadata_path = (
            self._find_metadata_path(
                normalized_namespace,
                normalized_hash,
            )
        )

        if metadata_path is None:
            self.statistics.disk_misses += 1
            return None

        try:
            metadata = (
                CacheEntryMetadata
                .from_dict(
                    read_json(
                        metadata_path
                    )
                )
            )

        except (
            CacheError,
            ValueError,
        ):
            self.statistics.disk_misses += 1
            self.statistics.integrity_failures += 1
            return None

        if (
            metadata.namespace
            != normalized_namespace
            or metadata.key_hash
            != normalized_hash
        ):
            self.statistics.disk_misses += 1
            self.statistics.integrity_failures += 1
            return None

        if metadata.dead:
            self.delete(
                normalized_namespace,
                normalized_hash,
            )

            self.statistics.disk_misses += 1
            self.statistics.expirations += 1

            return None

        if (
            metadata.expired
            and not allow_stale
        ):
            self.statistics.disk_misses += 1
            return None

        paths = self.paths(
            normalized_namespace,
            normalized_hash,
            compression=(
                metadata.compression
            ),
        )

        if not paths.payload_path.is_file():
            self.statistics.disk_misses += 1
            self.statistics.integrity_failures += 1
            return None

        try:
            stored_payload = (
                paths.payload_path.read_bytes()
            )

        except OSError:
            self.statistics.disk_misses += 1
            return None

        self.statistics.bytes_read += len(
            stored_payload
        )

        try:
            serialized = decompress_payload(
                stored_payload,
                compression=(
                    metadata.compression
                ),
            )

            if (
                verify_payload
                and metadata.payload_hash
                and not verify_hash(
                    serialized,
                    metadata.payload_hash,
                )
            ):
                raise CacheIntegrityError(
                    "Persistent cache payload hash "
                    "does not match metadata."
                )

            value = deserialize_value(
                serialized,
                serializer=(
                    metadata.serializer
                ),
            )

        except (
            CacheSerializationError,
            CacheIntegrityError,
        ):
            self.statistics.disk_misses += 1
            self.statistics.integrity_failures += 1

            return None

        if touch:
            metadata.touch()

            try:
                atomic_write_json(
                    paths.metadata_path,
                    metadata.to_dict(),
                )
            except OSError:
                pass

        self.statistics.disk_hits += 1

        if metadata.expired:
            self.statistics.stale_hits += 1

        return CacheEntry(
            value=value,
            metadata=metadata,
            layer="disk",
        )

    def metadata(
        self,
        namespace: str,
        key_hash_value: str,
    ) -> CacheEntryMetadata | None:
        """Read metadata without decoding the payload."""

        metadata_path = (
            self._find_metadata_path(
                normalize_namespace(
                    namespace
                ),
                normalize_key(
                    key_hash_value
                ),
            )
        )

        if metadata_path is None:
            return None

        try:
            return (
                CacheEntryMetadata
                .from_dict(
                    read_json(
                        metadata_path
                    )
                )
            )

        except (
            CacheError,
            ValueError,
        ):
            return None

    def exists(
        self,
        namespace: str,
        key_hash_value: str,
        *,
        include_expired: bool = False,
        include_stale: bool = True,
    ) -> bool:
        """Return whether a persistent entry exists."""

        metadata = self.metadata(
            namespace,
            key_hash_value,
        )

        if metadata is None:
            return False

        if include_expired:
            return True

        if metadata.dead:
            return False

        if metadata.expired:
            return include_stale

        return True

    def delete(
        self,
        namespace: str,
        key_hash_value: str,
    ) -> bool:
        """Delete one persistent cache entry."""

        normalized_namespace = (
            normalize_namespace(
                namespace
            )
        )

        normalized_hash = normalize_key(
            key_hash_value
        )

        uncompressed = self.paths(
            normalized_namespace,
            normalized_hash,
            compression=COMPRESSION_NONE,
        )

        compressed = self.paths(
            normalized_namespace,
            normalized_hash,
            compression=COMPRESSION_GZIP,
        )

        entry_root = (
            uncompressed.entry_root
        )

        if not entry_root.exists():
            return False

        lock = CacheFileLock(
            uncompressed.lock_path,
            timeout_seconds=(
                self.lock_timeout_seconds
            ),
            poll_seconds=(
                self.lock_poll_seconds
            ),
            stale_seconds=(
                self.stale_lock_seconds
            ),
            statistics=self.statistics,
        )

        deleted = False

        with self._thread_lock:
            try:
                with lock:
                    for path in (
                        uncompressed.payload_path,
                        compressed.payload_path,
                        uncompressed.metadata_path,
                    ):
                        if path.exists():
                            path.unlink(
                                missing_ok=True
                            )
                            deleted = True

                    try:
                        entry_root.rmdir()
                    except OSError:
                        pass

                    self._remove_empty_parents(
                        entry_root.parent,
                        stop_at=(
                            self.root
                            / normalized_namespace
                        ),
                    )

            except CacheLockError:
                return False

        if deleted:
            self.statistics.deletes += 1

        return deleted

    def clear(
        self,
        *,
        namespace: str | None = None,
    ) -> int:
        """Delete all persistent entries or one namespace."""

        target = (
            self.root
            / normalize_namespace(
                namespace
            )
            if namespace is not None
            else self.root
        )

        if not target.exists():
            return 0

        count = sum(
            1
            for _metadata_path
            in target.rglob(
                "metadata.json"
            )
        )

        if namespace is None:
            for child in list(
                self.root.iterdir()
            ):
                if child.is_dir():
                    shutil.rmtree(
                        child,
                        ignore_errors=True,
                    )
                else:
                    child.unlink(
                        missing_ok=True
                    )

        else:
            shutil.rmtree(
                target,
                ignore_errors=True,
            )

        self.statistics.deletes += count

        return count

    def iter_metadata(
        self,
        *,
        namespace: str | None = None,
    ) -> Iterator[
        CacheEntryMetadata
    ]:
        """Iterate persistent cache metadata."""

        search_root = (
            self.root
            / normalize_namespace(
                namespace
            )
            if namespace is not None
            else self.root
        )

        if not search_root.exists():
            return

        for metadata_path in sorted(
            search_root.rglob(
                "metadata.json"
            )
        ):
            try:
                yield (
                    CacheEntryMetadata
                    .from_dict(
                        read_json(
                            metadata_path
                        )
                    )
                )

            except (
                CacheError,
                ValueError,
            ):
                continue

    def iter_entries(
        self,
        *,
        namespace: str | None = None,
        allow_stale: bool = True,
        verify_payload: bool = True,
    ) -> Iterator[CacheEntry[Any]]:
        """Iterate decoded persistent cache entries."""

        for metadata in self.iter_metadata(
            namespace=namespace
        ):
            entry = self.get(
                metadata.namespace,
                metadata.key_hash,
                allow_stale=allow_stale,
                verify_payload=(
                    verify_payload
                ),
                touch=False,
            )

            if entry is not None:
                yield entry

    def find_by_tag(
        self,
        tag: str,
        *,
        namespace: str | None = None,
    ) -> list[CacheEntryMetadata]:
        """Return entries carrying a normalized tag."""

        normalized_tag = normalize_key(
            tag
        )

        if not normalized_tag:
            return []

        return [
            metadata
            for metadata
            in self.iter_metadata(
                namespace=namespace
            )
            if normalized_tag
            in metadata.tags
        ]

    def find_by_source(
        self,
        source: str,
        *,
        namespace: str | None = None,
    ) -> list[CacheEntryMetadata]:
        """Return entries matching a source string."""

        normalized_source = (
            normalize_space(source)
        )

        if not normalized_source:
            return []

        return [
            metadata
            for metadata
            in self.iter_metadata(
                namespace=namespace
            )
            if metadata.source
            == normalized_source
        ]

    def usage(
        self,
        *,
        namespace: str | None = None,
    ) -> dict[str, Any]:
        """Return persistent cache usage information."""

        search_root = (
            self.root
            / normalize_namespace(
                namespace
            )
            if namespace is not None
            else self.root
        )

        if not search_root.exists():
            return {
                "entries": 0,
                "payload_bytes": 0,
                "stored_bytes": 0,
                "filesystem_bytes": 0,
                "expired": 0,
                "stale": 0,
                "namespaces": 0,
            }

        entries = 0
        payload_bytes = 0
        stored_bytes = 0
        filesystem_bytes = 0
        expired = 0
        stale = 0
        namespaces: set[str] = set()

        for path in search_root.rglob("*"):
            if not path.is_file():
                continue

            try:
                filesystem_bytes += (
                    path.stat().st_size
                )
            except OSError:
                continue

        for metadata in self.iter_metadata(
            namespace=namespace
        ):
            entries += 1
            payload_bytes += (
                metadata.payload_bytes
            )
            stored_bytes += (
                metadata.stored_bytes
            )
            namespaces.add(
                metadata.namespace
            )

            if metadata.dead:
                expired += 1

            elif metadata.expired:
                stale += 1

        return {
            "entries": entries,
            "payload_bytes": (
                payload_bytes
            ),
            "stored_bytes": (
                stored_bytes
            ),
            "filesystem_bytes": (
                filesystem_bytes
            ),
            "expired": expired,
            "stale": stale,
            "namespaces": len(
                namespaces
            ),
        }

    def prune(
        self,
        *,
        namespace: str | None = None,
        delete_stale: bool = False,
        maximum_entries: int | None = None,
        maximum_bytes: int | None = None,
    ) -> CachePruneResult:
        """
        Remove expired, orphaned, and least-recently-used entries.

        Entries are first removed when dead. When delete_stale=True, entries
        inside the stale grace period are removed as well. Remaining entries
        are ordered by accessed_at and removed until configured limits are met.
        """

        maximum_entry_count = (
            self.maximum_entries
            if maximum_entries is None
            else max(
                0,
                int(maximum_entries),
            )
        )

        maximum_size_bytes = (
            self.maximum_bytes
            if maximum_bytes is None
            else max(
                0,
                int(maximum_bytes),
            )
        )

        result = CachePruneResult(
            scanned=0,
            deleted=0,
            expired_deleted=0,
            oversized_deleted=0,
            orphaned_deleted=0,
            bytes_freed=0,
        )

        records: list[
            tuple[
                CacheEntryMetadata,
                Path,
                int,
            ]
        ] = []

        search_root = (
            self.root
            / normalize_namespace(
                namespace
            )
            if namespace is not None
            else self.root
        )

        if not search_root.exists():
            return result

        metadata_paths = sorted(
            search_root.rglob(
                "metadata.json"
            )
        )

        for metadata_path in metadata_paths:
            result.scanned += 1

            entry_root = (
                metadata_path.parent
            )

            try:
                metadata = (
                    CacheEntryMetadata
                    .from_dict(
                        read_json(
                            metadata_path
                        )
                    )
                )

            except (
                CacheError,
                ValueError,
            ) as error:
                size = (
                    self._directory_size(
                        entry_root
                    )
                )

                shutil.rmtree(
                    entry_root,
                    ignore_errors=True,
                )

                result.deleted += 1
                result.orphaned_deleted += 1
                result.bytes_freed += size
                result.errors.append(
                    str(error)
                )

                continue

            paths = self.paths(
                metadata.namespace,
                metadata.key_hash,
                compression=(
                    metadata.compression
                ),
            )

            if not paths.payload_path.exists():
                size = (
                    self._directory_size(
                        entry_root
                    )
                )

                shutil.rmtree(
                    entry_root,
                    ignore_errors=True,
                )

                result.deleted += 1
                result.orphaned_deleted += 1
                result.bytes_freed += size

                continue

            size = self._directory_size(
                entry_root
            )

            should_expire = (
                metadata.dead
                or (
                    delete_stale
                    and metadata.expired
                )
            )

            if should_expire:
                shutil.rmtree(
                    entry_root,
                    ignore_errors=True,
                )

                result.deleted += 1
                result.expired_deleted += 1
                result.bytes_freed += size
                self.statistics.expirations += 1

                continue

            records.append(
                (
                    metadata,
                    entry_root,
                    size,
                )
            )

        orphan_payloads = self._find_orphan_payloads(
            search_root
        )

        for payload_path in orphan_payloads:
            try:
                size = (
                    payload_path.stat().st_size
                )
            except OSError:
                size = 0

            payload_path.unlink(
                missing_ok=True
            )

            result.deleted += 1
            result.orphaned_deleted += 1
            result.bytes_freed += size

        current_entries = len(
            records
        )

        current_bytes = sum(
            size
            for _metadata, _path, size
            in records
        )

        records.sort(
            key=lambda item: (
                item[0].accessed_at,
                item[0].created_at,
                item[0].key_hash,
            )
        )

        while records and (
            (
                maximum_entry_count > 0
                and current_entries
                > maximum_entry_count
            )
            or (
                maximum_size_bytes > 0
                and current_bytes
                > maximum_size_bytes
            )
        ):
            (
                _metadata,
                entry_root,
                size,
            ) = records.pop(0)

            shutil.rmtree(
                entry_root,
                ignore_errors=True,
            )

            current_entries -= 1
            current_bytes = max(
                0,
                current_bytes - size,
            )

            result.deleted += 1
            result.oversized_deleted += 1
            result.bytes_freed += size
            self.statistics.evictions += 1

        self.statistics.prunes += 1
        self.statistics.deletes += (
            result.deleted
        )

        return result

    def verify(
        self,
        *,
        namespace: str | None = None,
        verify_payloads: bool = True,
    ) -> CacheVerification:
        """Verify the persistent cache tree."""

        result = CacheVerification(
            valid=True,
            entries_checked=0,
            valid_entries=0,
            expired_entries=0,
            corrupt_entries=0,
            orphaned_payloads=0,
            orphaned_metadata=0,
        )

        search_root = (
            self.root
            / normalize_namespace(
                namespace
            )
            if namespace is not None
            else self.root
        )

        if not search_root.exists():
            return result

        metadata_paths = sorted(
            search_root.rglob(
                "metadata.json"
            )
        )

        known_payload_paths: set[
            Path
        ] = set()

        for metadata_path in metadata_paths:
            result.entries_checked += 1

            try:
                metadata = (
                    CacheEntryMetadata
                    .from_dict(
                        read_json(
                            metadata_path
                        )
                    )
                )

            except (
                CacheError,
                ValueError,
            ) as error:
                result.corrupt_entries += 1
                result.errors.append(
                    str(error)
                )
                continue

            if (
                metadata.schema_version
                != CACHE_SCHEMA_VERSION
            ):
                result.corrupt_entries += 1
                result.errors.append(
                    "Cache schema version mismatch "
                    f"for {metadata.key_hash}."
                )
                continue

            if not metadata.key_hash:
                result.corrupt_entries += 1
                result.errors.append(
                    "Cache metadata contains an "
                    "empty key hash."
                )
                continue

            paths = self.paths(
                metadata.namespace,
                metadata.key_hash,
                compression=(
                    metadata.compression
                ),
            )

            known_payload_paths.add(
                paths.payload_path
            )

            if not paths.payload_path.is_file():
                result.orphaned_metadata += 1
                result.errors.append(
                    "Cache metadata has no payload: "
                    f"{metadata.key_hash}."
                )
                continue

            if metadata.dead:
                result.expired_entries += 1

            if verify_payloads:
                try:
                    stored_payload = (
                        paths.payload_path
                        .read_bytes()
                    )

                    serialized = (
                        decompress_payload(
                            stored_payload,
                            compression=(
                                metadata.compression
                            ),
                        )
                    )

                    if (
                        metadata.payload_hash
                        and not verify_hash(
                            serialized,
                            metadata.payload_hash,
                        )
                    ):
                        raise (
                            CacheIntegrityError(
                                "payload hash mismatch"
                            )
                        )

                    deserialize_value(
                        serialized,
                        serializer=(
                            metadata.serializer
                        ),
                    )

                except (
                    OSError,
                    CacheError,
                ) as error:
                    result.corrupt_entries += 1
                    result.errors.append(
                        "Invalid cache payload "
                        f"{metadata.key_hash}: "
                        f"{error}"
                    )
                    continue

            result.valid_entries += 1

        for payload_path in (
            self._all_payload_paths(
                search_root
            )
        ):
            if payload_path not in (
                known_payload_paths
            ):
                result.orphaned_payloads += 1
                result.warnings.append(
                    "Orphaned cache payload: "
                    f"{payload_path.as_posix()}."
                )

        result.valid = not result.errors

        return result

    def touch(
        self,
        namespace: str,
        key_hash_value: str,
        *,
        extend_ttl_seconds: int | None = None,
        extend_stale_seconds: int | None = None,
    ) -> bool:
        """Update access time and optionally extend expiration."""

        metadata = self.metadata(
            namespace,
            key_hash_value,
        )

        if metadata is None:
            return False

        metadata.touch()
        metadata.updated_at = time.time()

        if extend_ttl_seconds is not None:
            ttl = max(
                0,
                int(
                    extend_ttl_seconds
                ),
            )

            metadata.expires_at = (
                metadata.updated_at + ttl
                if ttl > 0
                else None
            )

        if (
            metadata.expires_at
            is not None
            and extend_stale_seconds
            is not None
        ):
            metadata.stale_until = (
                metadata.expires_at
                + max(
                    0,
                    int(
                        extend_stale_seconds
                    ),
                )
            )

        paths = self.paths(
            metadata.namespace,
            metadata.key_hash,
            compression=(
                metadata.compression
            ),
        )

        try:
            atomic_write_json(
                paths.metadata_path,
                metadata.to_dict(),
            )
        except OSError:
            return False

        return True

    def update_metadata(
        self,
        namespace: str,
        key_hash_value: str,
        updates: Mapping[str, Any],
    ) -> CacheEntryMetadata | None:
        """Apply supported metadata updates to one entry."""

        metadata = self.metadata(
            namespace,
            key_hash_value,
        )

        if metadata is None:
            return None

        allowed_fields = {
            "expires_at",
            "stale_until",
            "tags",
            "source",
            "content_type",
            "etag",
            "last_modified",
            "status_code",
            "extra",
        }

        for field_name, value in (
            updates.items()
        ):
            if field_name not in (
                allowed_fields
            ):
                continue

            if field_name == "tags":
                metadata.tags = sorted(
                    {
                        normalize_key(tag)
                        for tag in (
                            value or []
                        )
                        if normalize_key(tag)
                    }
                )

            elif field_name == "extra":
                metadata.extra = (
                    dict(value)
                    if isinstance(
                        value,
                        Mapping,
                    )
                    else {}
                )

            elif field_name in {
                "expires_at",
                "stale_until",
            }:
                setattr(
                    metadata,
                    field_name,
                    optional_float(value),
                )

            elif field_name == "status_code":
                metadata.status_code = (
                    optional_int(value)
                )

            else:
                setattr(
                    metadata,
                    field_name,
                    normalize_space(value),
                )

        metadata.updated_at = time.time()

        paths = self.paths(
            metadata.namespace,
            metadata.key_hash,
            compression=(
                metadata.compression
            ),
        )

        atomic_write_json(
            paths.metadata_path,
            metadata.to_dict(),
        )

        return metadata

    def _find_metadata_path(
        self,
        namespace: str,
        key_hash_value: str,
    ) -> Path | None:
        """Return the metadata path when an entry exists."""

        paths = self.paths(
            namespace,
            key_hash_value,
            compression=COMPRESSION_NONE,
        )

        if paths.metadata_path.is_file():
            return paths.metadata_path

        return None

    @staticmethod
    def _directory_size(
        path: Path,
    ) -> int:
        """Return total bytes beneath a directory."""

        total = 0

        if not path.exists():
            return total

        for child in path.rglob("*"):
            if not child.is_file():
                continue

            try:
                total += child.stat().st_size
            except OSError:
                continue

        return total

    @staticmethod
    def _remove_empty_parents(
        path: Path,
        *,
        stop_at: Path,
    ) -> None:
        """Remove empty cache shard directories."""

        current = path

        while (
            current != stop_at
            and current.parent != current
        ):
            try:
                current.rmdir()
            except OSError:
                break

            current = current.parent

        try:
            stop_at.rmdir()
        except OSError:
            pass

    @staticmethod
    def _all_payload_paths(
        root: Path,
    ) -> Iterator[Path]:
        """Iterate every persistent payload file."""

        if not root.exists():
            return

        for path in root.rglob(
            "payload*"
        ):
            if (
                path.is_file()
                and path.name
                in {
                    (
                        "payload"
                        + CACHE_FILE_SUFFIX
                    ),
                    (
                        "payload"
                        + CACHE_COMPRESSED_SUFFIX
                    ),
                }
            ):
                yield path

    @classmethod
    def _find_orphan_payloads(
        cls,
        root: Path,
    ) -> list[Path]:
        """Return payload files without metadata."""

        orphans: list[Path] = []

        for payload_path in (
            cls._all_payload_paths(
                root
            )
        ):
            metadata_path = (
                payload_path.parent
                / "metadata.json"
            )

            if not metadata_path.is_file():
                orphans.append(
                    payload_path
                )

        return orphans
