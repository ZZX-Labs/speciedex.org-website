#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/cache_common.py

Shared cache constants, data models, serialization, hashing, and atomic I/O.

This module is an internal component of the public cache.py compatibility
wrapper. Import public cache APIs from static.tools.core.cache.

Copyright (c) 2026 ZZX-Laboratories
Licensed under the MIT License.
"""

from __future__ import annotations

import gzip
import hashlib
import hmac
import json
import os
import pickle
import shutil
import tempfile
import threading
import time
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field, is_dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import (
    Any,
    Callable,
    Generic,
    Iterable,
    Iterator,
    Mapping,
    MutableMapping,
    Sequence,
    TypeVar,
)


CACHE_SCHEMA_VERSION = 1

DEFAULT_MEMORY_MAX_ENTRIES = 10_000
DEFAULT_MEMORY_MAX_BYTES = 256 * 1024 * 1024

DEFAULT_DISK_MAX_ENTRIES = 250_000
DEFAULT_DISK_MAX_BYTES = 8 * 1024 * 1024 * 1024

DEFAULT_TTL_SECONDS = 60 * 60
DEFAULT_STALE_TTL_SECONDS = 24 * 60 * 60

DEFAULT_LOCK_TIMEOUT_SECONDS = 30.0
DEFAULT_LOCK_POLL_SECONDS = 0.05
DEFAULT_STALE_LOCK_SECONDS = 15 * 60

DEFAULT_PRUNE_INTERVAL_SECONDS = 15 * 60
DEFAULT_METADATA_FILENAME = "cache-metadata.json"

DEFAULT_COMPRESSION_THRESHOLD_BYTES = 4 * 1024
DEFAULT_FILE_MODE = 0o600
DEFAULT_DIRECTORY_MODE = 0o700

DEFAULT_NAMESPACE = "default"

CACHE_KEY_PREFIX = "spx-cache"
CACHE_FILE_SUFFIX = ".cache"
CACHE_COMPRESSED_SUFFIX = ".cache.gz"
CACHE_LOCK_SUFFIX = ".lock"

SERIALIZER_JSON = "json"
SERIALIZER_PICKLE = "pickle"
SERIALIZER_RAW = "raw"

SUPPORTED_SERIALIZERS = {
    SERIALIZER_JSON,
    SERIALIZER_PICKLE,
    SERIALIZER_RAW,
}

COMPRESSION_NONE = "none"
COMPRESSION_GZIP = "gzip"

SUPPORTED_COMPRESSION = {
    COMPRESSION_NONE,
    COMPRESSION_GZIP,
}


KeyType = TypeVar("KeyType")
ValueType = TypeVar("ValueType")


class CacheError(RuntimeError):
    """Base exception for cache failures."""


class CacheKeyError(CacheError):
    """Raised when a cache key cannot be normalized."""


class CacheSerializationError(CacheError):
    """Raised when cached data cannot be serialized or decoded."""


class CacheIntegrityError(CacheError):
    """Raised when a persistent cache entry fails verification."""


class CacheLockError(CacheError):
    """Raised when an exclusive cache lock cannot be acquired."""


class CacheConfigurationError(CacheError):
    """Raised when cache configuration is invalid."""


@dataclass(slots=True)
class CachePolicy:
    """
    Cache behavior for one namespace or operation.

    ttl_seconds:
        Maximum age before an entry expires.

    stale_ttl_seconds:
        Additional age during which an expired entry may be returned when
        allow_stale=True.

    memory:
        Store the entry in the in-memory LRU cache.

    disk:
        Store the entry in the persistent disk cache.

    serializer:
        json, pickle, or raw.

    compression:
        none or gzip.

    compress_above_bytes:
        Compression is enabled only when the serialized payload meets this
        threshold.

    refresh_on_access:
        Refresh the memory-entry access timestamp whenever it is read.

    cache_none:
        Permit caching None values.

    verify_hash:
        Verify persistent payload hashes when reading.
    """

    ttl_seconds: int = DEFAULT_TTL_SECONDS
    stale_ttl_seconds: int = DEFAULT_STALE_TTL_SECONDS
    memory: bool = True
    disk: bool = True
    serializer: str = SERIALIZER_PICKLE
    compression: str = COMPRESSION_GZIP
    compress_above_bytes: int = DEFAULT_COMPRESSION_THRESHOLD_BYTES
    refresh_on_access: bool = True
    cache_none: bool = False
    verify_hash: bool = True

    def __post_init__(self) -> None:
        self.ttl_seconds = max(
            0,
            int(self.ttl_seconds),
        )

        self.stale_ttl_seconds = max(
            0,
            int(self.stale_ttl_seconds),
        )

        self.compress_above_bytes = max(
            0,
            int(self.compress_above_bytes),
        )

        self.serializer = normalize_key(
            self.serializer
        )

        self.compression = normalize_key(
            self.compression
        )

        if self.serializer not in SUPPORTED_SERIALIZERS:
            raise CacheConfigurationError(
                f"Unsupported cache serializer: "
                f"{self.serializer!r}."
            )

        if self.compression not in SUPPORTED_COMPRESSION:
            raise CacheConfigurationError(
                f"Unsupported cache compression: "
                f"{self.compression!r}."
            )

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible cache policy."""

        return {
            "ttl_seconds": self.ttl_seconds,
            "stale_ttl_seconds": (
                self.stale_ttl_seconds
            ),
            "memory": self.memory,
            "disk": self.disk,
            "serializer": self.serializer,
            "compression": self.compression,
            "compress_above_bytes": (
                self.compress_above_bytes
            ),
            "refresh_on_access": (
                self.refresh_on_access
            ),
            "cache_none": self.cache_none,
            "verify_hash": self.verify_hash,
        }


@dataclass(slots=True)
class CacheEntryMetadata:
    """Metadata stored beside one cached payload."""

    schema_version: int
    namespace: str
    key: str
    key_hash: str
    created_at: float
    updated_at: float
    accessed_at: float
    expires_at: float | None
    stale_until: float | None
    serializer: str
    compression: str
    payload_hash: str
    payload_bytes: int
    stored_bytes: int
    hits: int = 0
    tags: list[str] = field(
        default_factory=list
    )
    source: str = ""
    content_type: str = ""
    etag: str = ""
    last_modified: str = ""
    status_code: int | None = None
    extra: dict[str, Any] = field(
        default_factory=dict
    )

    @property
    def expired(self) -> bool:
        """Return whether the entry is currently expired."""

        if self.expires_at is None:
            return False

        return time.time() >= self.expires_at

    @property
    def stale(self) -> bool:
        """Return whether the entry is expired but still within stale TTL."""

        current = time.time()

        if self.expires_at is None:
            return False

        if current < self.expires_at:
            return False

        if self.stale_until is None:
            return False

        return current < self.stale_until

    @property
    def dead(self) -> bool:
        """Return whether the entry is beyond both TTL and stale TTL."""

        current = time.time()

        if self.expires_at is None:
            return False

        if current < self.expires_at:
            return False

        if self.stale_until is None:
            return True

        return current >= self.stale_until

    @property
    def age_seconds(self) -> float:
        """Return age since creation."""

        return max(
            0.0,
            time.time() - self.created_at,
        )

    @property
    def idle_seconds(self) -> float:
        """Return age since last access."""

        return max(
            0.0,
            time.time() - self.accessed_at,
        )

    def touch(self) -> None:
        """Update access metadata."""

        self.accessed_at = time.time()
        self.hits += 1

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible metadata object."""

        return {
            "schema_version": (
                self.schema_version
            ),
            "namespace": self.namespace,
            "key": self.key,
            "key_hash": self.key_hash,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "accessed_at": self.accessed_at,
            "expires_at": self.expires_at,
            "stale_until": self.stale_until,
            "serializer": self.serializer,
            "compression": self.compression,
            "payload_hash": self.payload_hash,
            "payload_bytes": self.payload_bytes,
            "stored_bytes": self.stored_bytes,
            "hits": self.hits,
            "tags": list(self.tags),
            "source": self.source,
            "content_type": self.content_type,
            "etag": self.etag,
            "last_modified": (
                self.last_modified
            ),
            "status_code": self.status_code,
            "extra": dict(self.extra),
        }

    @classmethod
    def from_dict(
        cls,
        value: Mapping[str, Any],
    ) -> CacheEntryMetadata:
        """Build metadata from a decoded mapping."""

        return cls(
            schema_version=safe_int(
                value.get(
                    "schema_version",
                    CACHE_SCHEMA_VERSION,
                )
            ),
            namespace=normalize_namespace(
                value.get(
                    "namespace",
                    DEFAULT_NAMESPACE,
                )
            ),
            key=normalize_space(
                value.get("key")
            ),
            key_hash=normalize_key(
                value.get("key_hash")
            ),
            created_at=safe_float(
                value.get(
                    "created_at",
                    time.time(),
                )
            ),
            updated_at=safe_float(
                value.get(
                    "updated_at",
                    time.time(),
                )
            ),
            accessed_at=safe_float(
                value.get(
                    "accessed_at",
                    time.time(),
                )
            ),
            expires_at=optional_float(
                value.get("expires_at")
            ),
            stale_until=optional_float(
                value.get("stale_until")
            ),
            serializer=normalize_key(
                value.get(
                    "serializer",
                    SERIALIZER_PICKLE,
                )
            ),
            compression=normalize_key(
                value.get(
                    "compression",
                    COMPRESSION_NONE,
                )
            ),
            payload_hash=normalize_key(
                value.get("payload_hash")
            ),
            payload_bytes=safe_int(
                value.get("payload_bytes")
            ),
            stored_bytes=safe_int(
                value.get("stored_bytes")
            ),
            hits=safe_int(
                value.get("hits")
            ),
            tags=sorted(
                {
                    normalize_key(tag)
                    for tag in value.get(
                        "tags",
                        [],
                    )
                    if normalize_key(tag)
                }
            ),
            source=normalize_space(
                value.get("source")
            ),
            content_type=normalize_space(
                value.get("content_type")
            ),
            etag=normalize_space(
                value.get("etag")
            ),
            last_modified=normalize_space(
                value.get("last_modified")
            ),
            status_code=optional_int(
                value.get("status_code")
            ),
            extra=(
                dict(
                    value.get(
                        "extra",
                        {},
                    )
                )
                if isinstance(
                    value.get(
                        "extra",
                        {},
                    ),
                    Mapping,
                )
                else {}
            ),
        )


@dataclass(slots=True)
class CacheEntry(Generic[ValueType]):
    """One decoded cached value and its metadata."""

    value: ValueType
    metadata: CacheEntryMetadata
    layer: str

    @property
    def expired(self) -> bool:
        return self.metadata.expired

    @property
    def stale(self) -> bool:
        return self.metadata.stale

    @property
    def dead(self) -> bool:
        return self.metadata.dead

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible cache entry description."""

        return {
            "metadata": (
                self.metadata.to_dict()
            ),
            "layer": self.layer,
            "expired": self.expired,
            "stale": self.stale,
            "dead": self.dead,
        }


@dataclass(slots=True)
class CacheStatistics:
    """Mutable cache statistics."""

    memory_hits: int = 0
    memory_misses: int = 0
    disk_hits: int = 0
    disk_misses: int = 0
    stale_hits: int = 0
    writes: int = 0
    deletes: int = 0
    evictions: int = 0
    expirations: int = 0
    integrity_failures: int = 0
    serialization_failures: int = 0
    lock_failures: int = 0
    prunes: int = 0
    bytes_read: int = 0
    bytes_written: int = 0

    @property
    def hits(self) -> int:
        return (
            self.memory_hits
            + self.disk_hits
        )

    @property
    def misses(self) -> int:
        return (
            self.memory_misses
            + self.disk_misses
        )

    @property
    def requests(self) -> int:
        return self.hits + self.misses

    @property
    def hit_rate(self) -> float:
        if self.requests <= 0:
            return 0.0

        return self.hits / self.requests

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible statistics object."""

        return {
            "memory_hits": self.memory_hits,
            "memory_misses": (
                self.memory_misses
            ),
            "disk_hits": self.disk_hits,
            "disk_misses": self.disk_misses,
            "stale_hits": self.stale_hits,
            "writes": self.writes,
            "deletes": self.deletes,
            "evictions": self.evictions,
            "expirations": self.expirations,
            "integrity_failures": (
                self.integrity_failures
            ),
            "serialization_failures": (
                self.serialization_failures
            ),
            "lock_failures": (
                self.lock_failures
            ),
            "prunes": self.prunes,
            "bytes_read": self.bytes_read,
            "bytes_written": (
                self.bytes_written
            ),
            "hits": self.hits,
            "misses": self.misses,
            "requests": self.requests,
            "hit_rate": round(
                self.hit_rate,
                6,
            ),
        }


@dataclass(slots=True)
class MemoryCacheItem(Generic[ValueType]):
    """Internal in-memory LRU entry."""

    value: ValueType
    metadata: CacheEntryMetadata
    estimated_bytes: int


@dataclass(slots=True)
class CachePaths:
    """Filesystem paths for one persistent cache entry."""

    namespace_root: Path
    entry_root: Path
    payload_path: Path
    metadata_path: Path
    lock_path: Path


@dataclass(slots=True)
class CacheVerification:
    """Verification result for one cache tree."""

    valid: bool
    entries_checked: int
    valid_entries: int
    expired_entries: int
    corrupt_entries: int
    orphaned_payloads: int
    orphaned_metadata: int
    errors: list[str] = field(
        default_factory=list
    )
    warnings: list[str] = field(
        default_factory=list
    )

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible verification result."""

        return {
            "valid": self.valid,
            "entries_checked": (
                self.entries_checked
            ),
            "valid_entries": (
                self.valid_entries
            ),
            "expired_entries": (
                self.expired_entries
            ),
            "corrupt_entries": (
                self.corrupt_entries
            ),
            "orphaned_payloads": (
                self.orphaned_payloads
            ),
            "orphaned_metadata": (
                self.orphaned_metadata
            ),
            "errors": list(self.errors),
            "warnings": list(
                self.warnings
            ),
        }


@dataclass(slots=True)
class CachePruneResult:
    """Result of a cache-pruning operation."""

    scanned: int
    deleted: int
    expired_deleted: int
    oversized_deleted: int
    orphaned_deleted: int
    bytes_freed: int
    errors: list[str] = field(
        default_factory=list
    )

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible prune result."""

        return {
            "scanned": self.scanned,
            "deleted": self.deleted,
            "expired_deleted": (
                self.expired_deleted
            ),
            "oversized_deleted": (
                self.oversized_deleted
            ),
            "orphaned_deleted": (
                self.orphaned_deleted
            ),
            "bytes_freed": (
                self.bytes_freed
            ),
            "errors": list(self.errors),
        }


def utc_now() -> str:
    """Return the current UTC timestamp."""

    return (
        datetime.now(UTC)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def normalize_space(value: Any) -> str:
    """Normalize whitespace in arbitrary text."""

    return " ".join(
        str(
            value
            if value is not None
            else ""
        )
        .strip()
        .split()
    )


def normalize_key(value: Any) -> str:
    """Normalize text for deterministic comparisons."""

    return normalize_space(
        value
    ).casefold()


def normalize_namespace(value: Any) -> str:
    """Normalize a cache namespace for filesystem use."""

    text = normalize_key(
        value
    )

    text = "".join(
        character
        if (
            character.isalnum()
            or character in {
                "-",
                "_",
                ".",
            }
        )
        else "-"
        for character in text
    )

    text = text.strip(
        "-."
    )

    return text or DEFAULT_NAMESPACE


def safe_int(
    value: Any,
    default: int = 0,
) -> int:
    """Convert a value to an integer."""

    try:
        return int(value)
    except (
        TypeError,
        ValueError,
    ):
        return int(default)


def optional_int(
    value: Any,
) -> int | None:
    """Convert a value to an optional integer."""

    if value is None:
        return None

    try:
        return int(value)
    except (
        TypeError,
        ValueError,
    ):
        return None


def safe_float(
    value: Any,
    default: float = 0.0,
) -> float:
    """Convert a value to a float."""

    try:
        return float(value)
    except (
        TypeError,
        ValueError,
    ):
        return float(default)


def optional_float(
    value: Any,
) -> float | None:
    """Convert a value to an optional float."""

    if value is None:
        return None

    try:
        return float(value)
    except (
        TypeError,
        ValueError,
    ):
        return None


def canonicalize_value(
    value: Any,
) -> Any:
    """
    Convert supported values into deterministic JSON-compatible data.

    This is used only for cache-key generation. Cached payload serialization
    is handled separately.
    """

    if value is None:
        return None

    if isinstance(
        value,
        (
            str,
            int,
            float,
            bool,
        ),
    ):
        return value

    if isinstance(
        value,
        bytes,
    ):
        return {
            "__type__": "bytes",
            "hex": value.hex(),
        }

    if isinstance(
        value,
        Path,
    ):
        return value.as_posix()

    if is_dataclass(value):
        return canonicalize_value(
            asdict(value)
        )

    if hasattr(
        value,
        "to_dict",
    ) and callable(
        value.to_dict
    ):
        return canonicalize_value(
            value.to_dict()
        )

    if isinstance(
        value,
        Mapping,
    ):
        return {
            normalize_space(key): (
                canonicalize_value(item)
            )
            for key, item in sorted(
                value.items(),
                key=lambda pair: (
                    normalize_space(
                        pair[0]
                    )
                ),
            )
        }

    if isinstance(
        value,
        (
            set,
            frozenset,
        ),
    ):
        normalized = [
            canonicalize_value(item)
            for item in value
        ]

        return sorted(
            normalized,
            key=lambda item: json.dumps(
                item,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ),
        )

    if isinstance(
        value,
        Sequence,
    ) and not isinstance(
        value,
        (
            str,
            bytes,
            bytearray,
        ),
    ):
        return [
            canonicalize_value(item)
            for item in value
        ]

    if isinstance(
        value,
        Iterable,
    ):
        return [
            canonicalize_value(item)
            for item in value
        ]

    return normalize_space(value)


def stable_json_bytes(
    value: Any,
) -> bytes:
    """Return deterministic UTF-8 JSON bytes."""

    return json.dumps(
        canonicalize_value(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def stable_hash(
    value: Any,
) -> str:
    """Return a SHA-256 digest of deterministic JSON data."""

    return hashlib.sha256(
        stable_json_bytes(value)
    ).hexdigest()


def payload_hash(
    payload: bytes,
) -> str:
    """Return a SHA-256 digest for serialized payload bytes."""

    return hashlib.sha256(
        payload
    ).hexdigest()


def verify_hash(
    payload: bytes,
    expected: str,
) -> bool:
    """Verify serialized payload bytes against a digest."""

    actual = payload_hash(payload)

    return hmac.compare_digest(
        actual,
        normalize_key(expected),
    )


def cache_key(
    key: Any,
    *,
    namespace: str = DEFAULT_NAMESPACE,
) -> tuple[str, str]:
    """
    Return the canonical cache key and SHA-256 key digest.

    The canonical key remains human-readable where possible. The digest is
    used for persistent file paths.
    """

    normalized_namespace = (
        normalize_namespace(namespace)
    )

    if isinstance(key, str):
        canonical_key = normalize_space(
            key
        )

    else:
        canonical_key = json.dumps(
            canonicalize_value(key),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )

    if not canonical_key:
        raise CacheKeyError(
            "Cache key cannot be empty."
        )

    digest = stable_hash(
        {
            "schema_version": (
                CACHE_SCHEMA_VERSION
            ),
            "prefix": CACHE_KEY_PREFIX,
            "namespace": (
                normalized_namespace
            ),
            "key": canonical_key,
        }
    )

    return (
        canonical_key,
        digest,
    )


def estimate_size_bytes(
    value: Any,
) -> int:
    """
    Estimate the memory cost of a cached value.

    Pickle is used only for estimating size. Failures fall back to the object's
    textual representation.
    """

    try:
        return len(
            pickle.dumps(
                value,
                protocol=pickle.HIGHEST_PROTOCOL,
            )
        )
    except Exception:
        return len(
            repr(value).encode(
                "utf-8",
                errors="replace",
            )
        )


def serialize_value(
    value: Any,
    *,
    serializer: str,
) -> bytes:
    """Serialize one cached value."""

    normalized = normalize_key(
        serializer
    )

    try:
        if normalized == SERIALIZER_JSON:
            return json.dumps(
                value,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")

        if normalized == SERIALIZER_PICKLE:
            return pickle.dumps(
                value,
                protocol=pickle.HIGHEST_PROTOCOL,
            )

        if normalized == SERIALIZER_RAW:
            if isinstance(value, bytes):
                return value

            if isinstance(value, bytearray):
                return bytes(value)

            if isinstance(value, memoryview):
                return value.tobytes()

            raise CacheSerializationError(
                "The raw serializer requires bytes, "
                "bytearray, or memoryview."
            )

    except CacheSerializationError:
        raise

    except Exception as error:
        raise CacheSerializationError(
            f"Unable to serialize cache value "
            f"using {normalized}: {error}"
        ) from error

    raise CacheSerializationError(
        f"Unsupported serializer: "
        f"{serializer!r}."
    )


def deserialize_value(
    payload: bytes,
    *,
    serializer: str,
) -> Any:
    """Decode one cached value."""

    normalized = normalize_key(
        serializer
    )

    try:
        if normalized == SERIALIZER_JSON:
            return json.loads(
                payload.decode("utf-8")
            )

        if normalized == SERIALIZER_PICKLE:
            return pickle.loads(
                payload
            )

        if normalized == SERIALIZER_RAW:
            return payload

    except Exception as error:
        raise CacheSerializationError(
            f"Unable to decode cache payload "
            f"using {normalized}: {error}"
        ) from error

    raise CacheSerializationError(
        f"Unsupported serializer: "
        f"{serializer!r}."
    )


def compress_payload(
    payload: bytes,
    *,
    compression: str,
    threshold: int,
) -> tuple[bytes, str]:
    """Compress payload bytes when configured and large enough."""

    normalized = normalize_key(
        compression
    )

    if (
        normalized == COMPRESSION_NONE
        or len(payload) < threshold
    ):
        return (
            payload,
            COMPRESSION_NONE,
        )

    if normalized == COMPRESSION_GZIP:
        return (
            gzip.compress(
                payload,
                compresslevel=6,
                mtime=0,
            ),
            COMPRESSION_GZIP,
        )

    raise CacheSerializationError(
        f"Unsupported compression: "
        f"{compression!r}."
    )


def decompress_payload(
    payload: bytes,
    *,
    compression: str,
) -> bytes:
    """Decompress persistent payload bytes."""

    normalized = normalize_key(
        compression
    )

    if normalized == COMPRESSION_NONE:
        return payload

    if normalized == COMPRESSION_GZIP:
        try:
            return gzip.decompress(
                payload
            )
        except OSError as error:
            raise CacheSerializationError(
                f"Unable to decompress gzip cache "
                f"payload: {error}"
            ) from error

    raise CacheSerializationError(
        f"Unsupported compression: "
        f"{compression!r}."
    )


def atomic_write_bytes(
    path: Path,
    payload: bytes,
    *,
    mode: int = DEFAULT_FILE_MODE,
) -> None:
    """Atomically write binary data."""

    path.parent.mkdir(
        parents=True,
        exist_ok=True,
        mode=DEFAULT_DIRECTORY_MODE,
    )

    temporary: Path | None = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
            temporary = Path(
                handle.name
            )

        try:
            os.chmod(
                temporary,
                mode,
            )
        except OSError:
            pass

        temporary.replace(path)

    finally:
        if (
            temporary is not None
            and temporary.exists()
        ):
            temporary.unlink(
                missing_ok=True
            )


def atomic_write_json(
    path: Path,
    value: Any,
) -> None:
    """Atomically write formatted UTF-8 JSON."""

    payload = (
        json.dumps(
            value,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")

    atomic_write_bytes(
        path,
        payload,
    )


def read_json(
    path: Path,
) -> dict[str, Any]:
    """Read a JSON object from disk."""

    try:
        value = json.loads(
            path.read_text(
                encoding="utf-8",
            )
        )
    except OSError as error:
        raise CacheError(
            f"Unable to read cache metadata "
            f"{path}: {error}"
        ) from error
    except json.JSONDecodeError as error:
        raise CacheIntegrityError(
            f"Invalid cache metadata JSON in "
            f"{path}: {error}"
        ) from error

    if not isinstance(value, dict):
        raise CacheIntegrityError(
            f"Cache metadata root is not an "
            f"object: {path}"
        )

    return value
