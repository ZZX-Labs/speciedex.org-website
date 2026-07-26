#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/cache_operations.py

Cache warming, export, import, and persistent metadata rebuild operations.

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

class CacheWarmTask:
    """One cache-warming task."""

    name: str
    namespace: str
    key: Any
    loader: Callable[[], Any]
    policy: CachePolicy | None = None
    ttl_seconds: int | None = None
    stale_ttl_seconds: int | None = None
    tags: tuple[str, ...] = ()
    source: str = ""
    overwrite: bool = False


@dataclass(slots=True)
class CacheWarmResult:
    """Result of warming multiple cache entries."""

    attempted: int
    loaded: int
    already_cached: int
    failed: int
    errors: list[dict[str, str]] = field(
        default_factory=list
    )

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible warm result."""

        return {
            "attempted": self.attempted,
            "loaded": self.loaded,
            "already_cached": (
                self.already_cached
            ),
            "failed": self.failed,
            "errors": list(
                self.errors
            ),
        }


def warm_cache(
    manager: CacheManager,
    tasks: Iterable[CacheWarmTask],
    *,
    allow_stale: bool = False,
) -> CacheWarmResult:
    """Execute cache-warming tasks in deterministic order."""

    task_values = sorted(
        list(tasks),
        key=lambda task: (
            normalize_namespace(
                task.namespace
            ),
            normalize_space(
                task.name
            ),
        ),
    )

    result = CacheWarmResult(
        attempted=0,
        loaded=0,
        already_cached=0,
        failed=0,
    )

    for task in task_values:
        result.attempted += 1

        try:
            if (
                not task.overwrite
                and manager.contains(
                    task.key,
                    namespace=(
                        task.namespace
                    ),
                    allow_stale=(
                        allow_stale
                    ),
                    policy=task.policy,
                )
            ):
                result.already_cached += 1
                continue

            value = task.loader()

            manager.set(
                task.key,
                value,
                namespace=task.namespace,
                policy=task.policy,
                ttl_seconds=(
                    task.ttl_seconds
                ),
                stale_ttl_seconds=(
                    task.stale_ttl_seconds
                ),
                tags=task.tags,
                source=task.source,
            )

            result.loaded += 1

        except Exception as error:
            result.failed += 1

            result.errors.append(
                {
                    "name": task.name,
                    "namespace": (
                        normalize_namespace(
                            task.namespace
                        )
                    ),
                    "error": str(error),
                }
            )

    return result


@dataclass(slots=True)
class CacheExportResult:
    """Result of exporting persistent cache entries."""

    output_path: str
    entries: int
    payload_bytes: int
    namespaces: list[str]

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible export result."""

        return {
            "output_path": self.output_path,
            "entries": self.entries,
            "payload_bytes": (
                self.payload_bytes
            ),
            "namespaces": list(
                self.namespaces
            ),
        }


@dataclass(slots=True)
class CacheImportResult:
    """Result of importing cache entries."""

    source_path: str
    entries_seen: int
    entries_imported: int
    entries_skipped: int
    entries_failed: int
    errors: list[str] = field(
        default_factory=list
    )

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible import result."""

        return {
            "source_path": self.source_path,
            "entries_seen": (
                self.entries_seen
            ),
            "entries_imported": (
                self.entries_imported
            ),
            "entries_skipped": (
                self.entries_skipped
            ),
            "entries_failed": (
                self.entries_failed
            ),
            "errors": list(
                self.errors
            ),
        }


def export_cache(
    manager: CacheManager,
    output_path: Path,
    *,
    namespace: str | None = None,
    include_values: bool = True,
    allow_stale: bool = True,
) -> CacheExportResult:
    """
    Export persistent cache entries to a portable pickle file.

    Pickle export is intended only for trusted Speciedex cache data.
    """

    destination = Path(
        output_path
    )

    records: list[
        dict[str, Any]
    ] = []

    namespaces: set[str] = set()
    payload_bytes = 0

    for metadata in (
        manager.disk.iter_metadata(
            namespace=namespace
        )
    ):
        record: dict[str, Any] = {
            "metadata": (
                metadata.to_dict()
            ),
        }

        if include_values:
            entry = manager.disk.get(
                metadata.namespace,
                metadata.key_hash,
                allow_stale=allow_stale,
                verify_payload=True,
                touch=False,
            )

            if entry is None:
                continue

            record["value"] = entry.value

        records.append(record)
        namespaces.add(
            metadata.namespace
        )

        payload_bytes += (
            metadata.payload_bytes
        )

    package = {
        "schema_version": (
            CACHE_SCHEMA_VERSION
        ),
        "generated_at": utc_now(),
        "namespace": (
            normalize_namespace(
                namespace
            )
            if namespace is not None
            else None
        ),
        "include_values": (
            include_values
        ),
        "entries": records,
    }

    payload = pickle.dumps(
        package,
        protocol=pickle.HIGHEST_PROTOCOL,
    )

    atomic_write_bytes(
        destination,
        gzip.compress(
            payload,
            compresslevel=6,
            mtime=0,
        ),
    )

    return CacheExportResult(
        output_path=(
            destination.as_posix()
        ),
        entries=len(records),
        payload_bytes=payload_bytes,
        namespaces=sorted(
            namespaces
        ),
    )


def import_cache(
    manager: CacheManager,
    source_path: Path,
    *,
    overwrite: bool = False,
    namespace_override: str | None = None,
) -> CacheImportResult:
    """
    Import a trusted cache export produced by export_cache().
    """

    source = Path(
        source_path
    )

    result = CacheImportResult(
        source_path=source.as_posix(),
        entries_seen=0,
        entries_imported=0,
        entries_skipped=0,
        entries_failed=0,
    )

    try:
        compressed = source.read_bytes()

        package = pickle.loads(
            gzip.decompress(
                compressed
            )
        )

    except (
        OSError,
        OSError,
        pickle.PickleError,
        EOFError,
        ValueError,
    ) as error:
        raise CacheSerializationError(
            "Unable to import cache package "
            f"{source}: {error}"
        ) from error

    if not isinstance(
        package,
        Mapping,
    ):
        raise CacheSerializationError(
            "Cache import package root is not "
            "a mapping."
        )

    if safe_int(
        package.get(
            "schema_version"
        )
    ) != CACHE_SCHEMA_VERSION:
        raise CacheIntegrityError(
            "Cache import schema version "
            "does not match."
        )

    entries = package.get(
        "entries",
        [],
    )

    if not isinstance(
        entries,
        list,
    ):
        raise CacheSerializationError(
            "Cache import entries value is "
            "not a list."
        )

    for record in entries:
        result.entries_seen += 1

        try:
            if not isinstance(
                record,
                Mapping,
            ):
                raise CacheSerializationError(
                    "Cache import entry is not "
                    "a mapping."
                )

            metadata_value = record.get(
                "metadata"
            )

            if not isinstance(
                metadata_value,
                Mapping,
            ):
                raise CacheSerializationError(
                    "Cache import entry has no "
                    "metadata mapping."
                )

            metadata = (
                CacheEntryMetadata
                .from_dict(
                    metadata_value
                )
            )

            namespace = (
                normalize_namespace(
                    namespace_override
                )
                if namespace_override
                is not None
                else metadata.namespace
            )

            if (
                not overwrite
                and manager.disk.exists(
                    namespace,
                    metadata.key_hash,
                    include_expired=True,
                )
            ):
                result.entries_skipped += 1
                continue

            if "value" not in record:
                result.entries_skipped += 1
                continue

            value = record["value"]

            current_time = time.time()

            remaining_ttl: int

            if metadata.expires_at is None:
                remaining_ttl = 0
            else:
                remaining_ttl = max(
                    1,
                    int(
                        metadata.expires_at
                        - current_time
                    ),
                )

            if (
                metadata.stale_until is None
                or metadata.expires_at is None
            ):
                remaining_stale = 0
            else:
                remaining_stale = max(
                    0,
                    int(
                        metadata.stale_until
                        - max(
                            current_time,
                            metadata.expires_at,
                        )
                    ),
                )

            policy = CachePolicy(
                ttl_seconds=remaining_ttl,
                stale_ttl_seconds=(
                    remaining_stale
                ),
                memory=True,
                disk=True,
                serializer=(
                    metadata.serializer
                ),
                compression=(
                    metadata.compression
                ),
                compress_above_bytes=0,
                refresh_on_access=True,
                cache_none=True,
                verify_hash=True,
            )

            manager.set(
                metadata.key,
                value,
                namespace=namespace,
                policy=policy,
                tags=metadata.tags,
                source=metadata.source,
                content_type=(
                    metadata.content_type
                ),
                etag=metadata.etag,
                last_modified=(
                    metadata.last_modified
                ),
                status_code=(
                    metadata.status_code
                ),
                extra=metadata.extra,
            )

            result.entries_imported += 1

        except Exception as error:
            result.entries_failed += 1
            result.errors.append(
                str(error)
            )

    return result


@dataclass(slots=True)
class CacheRebuildResult:
    """Result of rebuilding cache metadata."""

    scanned_directories: int
    repaired_metadata: int
    deleted_corrupt_entries: int
    deleted_orphans: int
    errors: list[str] = field(
        default_factory=list
    )

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible rebuild result."""

        return {
            "scanned_directories": (
                self.scanned_directories
            ),
            "repaired_metadata": (
                self.repaired_metadata
            ),
            "deleted_corrupt_entries": (
                self.deleted_corrupt_entries
            ),
            "deleted_orphans": (
                self.deleted_orphans
            ),
            "errors": list(
                self.errors
            ),
        }


def rebuild_cache(
    manager: CacheManager,
    *,
    namespace: str | None = None,
    delete_corrupt: bool = True,
) -> CacheRebuildResult:
    """
    Inspect persistent entry directories and repair recoverable metadata.
    """

    search_root = (
        manager.root
        / normalize_namespace(
            namespace
        )
        if namespace is not None
        else manager.root
    )

    result = CacheRebuildResult(
        scanned_directories=0,
        repaired_metadata=0,
        deleted_corrupt_entries=0,
        deleted_orphans=0,
    )

    if not search_root.exists():
        return result

    entry_directories: set[
        Path
    ] = set()

    for metadata_path in search_root.rglob(
        "metadata.json"
    ):
        entry_directories.add(
            metadata_path.parent
        )

    for payload_path in (
        manager.disk._all_payload_paths(
            search_root
        )
    ):
        entry_directories.add(
            payload_path.parent
        )

    for entry_root in sorted(
        entry_directories
    ):
        result.scanned_directories += 1

        metadata_path = (
            entry_root
            / "metadata.json"
        )

        payload_candidates = [
            entry_root
            / (
                "payload"
                + CACHE_FILE_SUFFIX
            ),
            entry_root
            / (
                "payload"
                + CACHE_COMPRESSED_SUFFIX
            ),
        ]

        payload_path = next(
            (
                path
                for path
                in payload_candidates
                if path.is_file()
            ),
            None,
        )

        if payload_path is None:
            if delete_corrupt:
                shutil.rmtree(
                    entry_root,
                    ignore_errors=True,
                )

                result.deleted_orphans += 1

            continue

        if not metadata_path.is_file():
            if delete_corrupt:
                shutil.rmtree(
                    entry_root,
                    ignore_errors=True,
                )

                result.deleted_orphans += 1

            continue

        try:
            metadata = (
                CacheEntryMetadata
                .from_dict(
                    read_json(
                        metadata_path
                    )
                )
            )

            stored_payload = (
                payload_path.read_bytes()
            )

            serialized = decompress_payload(
                stored_payload,
                compression=(
                    metadata.compression
                ),
            )

            calculated_hash = payload_hash(
                serialized
            )

            changed = False

            if (
                metadata.payload_hash
                != calculated_hash
            ):
                metadata.payload_hash = (
                    calculated_hash
                )

                changed = True

            if (
                metadata.payload_bytes
                != len(serialized)
            ):
                metadata.payload_bytes = len(
                    serialized
                )

                changed = True

            if (
                metadata.stored_bytes
                != len(stored_payload)
            ):
                metadata.stored_bytes = len(
                    stored_payload
                )

                changed = True

            if (
                metadata.schema_version
                != CACHE_SCHEMA_VERSION
            ):
                metadata.schema_version = (
                    CACHE_SCHEMA_VERSION
                )

                changed = True

            deserialize_value(
                serialized,
                serializer=(
                    metadata.serializer
                ),
            )

            if changed:
                metadata.updated_at = (
                    time.time()
                )

                atomic_write_json(
                    metadata_path,
                    metadata.to_dict(),
                )

                result.repaired_metadata += 1

        except Exception as error:
            result.errors.append(
                f"{entry_root.as_posix()}: "
                f"{error}"
            )

            if delete_corrupt:
                shutil.rmtree(
                    entry_root,
                    ignore_errors=True,
                )

                result.deleted_corrupt_entries += 1

    manager.memory.clear(
        namespace=namespace
    )

    return result
