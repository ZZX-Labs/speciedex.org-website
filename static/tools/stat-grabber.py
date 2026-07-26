#!/usr/bin/env python3
"""
Speciedex.org
static/tools/stat-grabber.py

Main entry point for the multi-source, append-only Speciedex taxonomic
ingestion system. Provider implementations live in:

    static/tools/providers/

Every provider registered in providers.json must have a matching module:

    static/tools/providers/<provider-name>.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import sqlite3
import sys
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

TOOLS_ROOT = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_ROOT.parents[1]

if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from providers.common import HTTPClient, Taxon
from providers.loader import load_provider

NAME = "Speciedex Stat Grabber"
VERSION = "3.2.0"
SCHEMA = 1
LOG = logging.getLogger("speciedex.stat_grabber")

ACTIVE_STATUSES = {
    "accepted",
    "valid",
    "provisionally accepted",
    "unknown",
    "reference",
}

RANKS = {
    "species": "species",
    "subspecies": "subspecies",
    "genera": "genus",
    "families": "family",
    "orders": "order",
    "classes": "class",
    "phyla": "phylum",
    "kingdoms": "kingdom",
}

RANK_ALIASES = {
    "sp": "species",
    "sp.": "species",
    "species": "species",
    "subspecies": "subspecies",
    "subsp": "subspecies",
    "subsp.": "subspecies",
    "ssp": "subspecies",
    "ssp.": "subspecies",
    "gen": "genus",
    "gen.": "genus",
    "genus": "genus",
    "fam": "family",
    "fam.": "family",
    "family": "family",
    "ord": "order",
    "ord.": "order",
    "order": "order",
    "class": "class",
    "classis": "class",
    "phylum": "phylum",
    "division": "phylum",
    "kingdom": "kingdom",
    "regnum": "kingdom",
}

SPECIEDEX_ID_PATTERN = re.compile(
    r"^spx:sha256:[0-9a-f]{64}$"
)

SAFE_PROVIDER_NAME_PATTERN = re.compile(
    r"^[a-z0-9][a-z0-9_-]*$"
)

STATUS_ALIASES = {
    "accepted name": "accepted",
    "current": "accepted",
    "valid name": "valid",
    "provisional": "provisionally accepted",
    "provisionally_accepted": "provisionally accepted",
}


def now() -> str:
    return datetime.now(timezone.utc).replace(
        microsecond=0
    ).isoformat().replace("+00:00", "Z")


def normalize_space(value: Any) -> str:
    """Collapse whitespace and remove unsafe control characters."""

    text = str(
        value
        if value is not None
        else ""
    )
    text = "".join(
        character
        for character in text
        if (
            character in "\t\n\r"
            or ord(
                character
            ) >= 32
        )
        and character not in {
            "\u200b",
            "\u200c",
            "\u200d",
            "\ufeff",
        }
    )
    return " ".join(
        text.strip().split()
    )


def normalize_key(value: Any) -> str:
    return normalize_space(value).casefold()


def normalize_rank(value: Any) -> str:
    rank = normalize_key(value).replace("_", " ").replace("-", " ")
    rank = " ".join(rank.split())
    return RANK_ALIASES.get(rank, rank.replace(" ", "_") or "unknown")


def normalize_status(value: Any) -> str:
    status = normalize_key(value).replace("_", " ")
    status = " ".join(status.split())
    return STATUS_ALIASES.get(status, status or "unknown")


def normalize_taxon_record(record: Taxon) -> Taxon:
    """Normalize fields that directly drive identity and statistics."""
    record.provider = normalize_key(record.provider)
    record.provider_id = normalize_space(record.provider_id)
    record.scientific_name = normalize_space(record.scientific_name)
    record.canonical_name = (
        normalize_space(record.canonical_name)
        or record.scientific_name
    )
    record.rank = normalize_rank(record.rank)
    record.status = normalize_status(record.status)
    record.authorship = normalize_space(record.authorship)
    record.kingdom = normalize_space(record.kingdom)
    record.phylum = normalize_space(record.phylum)
    record.class_name = normalize_space(record.class_name)
    record.order = normalize_space(record.order)
    record.family = normalize_space(record.family)
    record.genus = normalize_space(record.genus)
    record.synonyms = [
        normalize_space(value)
        for value in record.synonyms
        if normalize_space(value)
    ]
    return record


def safe_int(value: Any, default: int = 0) -> int:
    """Parse a non-negative integer without truncating fractions."""

    if isinstance(
        value,
        bool,
    ):
        return default

    if isinstance(
        value,
        int,
    ):
        return value if value >= 0 else default

    if isinstance(
        value,
        float,
    ):
        if (
            value.is_integer()
            and value >= 0
        ):
            return int(
                value
            )
        return default

    normalized = normalize_space(
        value
    )

    if not re.fullmatch(
        r"[0-9]+",
        normalized,
    ):
        return default

    return int(
        normalized
    )


def strict_positive_int(
    value: Any,
    name: str,
) -> int:
    """Parse a strictly positive integer CLI/configuration value."""

    parsed = safe_int(
        value,
        -1,
    )

    if parsed < 1:
        raise ValueError(
            f"{name} must be a positive integer."
        )

    return parsed


def safe_provider_name(
    value: Any,
) -> str:
    """Validate and normalize a provider registry name."""

    normalized = normalize_key(
        value
    )

    if not SAFE_PROVIDER_NAME_PATTERN.fullmatch(
        normalized
    ):
        raise ValueError(
            f"Invalid provider name: {value!r}."
        )

    return normalized


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        value,
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
        allow_nan=False,
    ) + "\n"
    temporary: Path | None = None

    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            newline="\n",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
            temporary = Path(handle.name)
        temporary.replace(path)

        try:
            directory_fd = os.open(
                path.parent,
                os.O_RDONLY,
            )
        except OSError:
            directory_fd = None

        if directory_fd is not None:
            try:
                os.fsync(
                    directory_fd
                )
            finally:
                os.close(
                    directory_fd
                )
    finally:
        if temporary and temporary.exists():
            temporary.unlink(missing_ok=True)


def append_jsonl(
    path: Path,
    values: Iterable[dict[str, Any]],
) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open(
        "a",
        encoding="utf-8",
        newline="\n",
    ) as handle:
        for value in values:
            handle.write(
                json.dumps(
                    value,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    sort_keys=True,
                    allow_nan=False,
                )
            )
            handle.write("\n")
            count += 1
        handle.flush()
        os.fsync(handle.fileno())
    return count


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(
            lambda: handle.read(1024 * 1024),
            b"",
        ):
            digest.update(chunk)
    return digest.hexdigest()


class Archive:
    def __init__(
        self,
        root: Path,
        target_bytes: int,
        maximum_bytes: int,
    ) -> None:
        self.root = Path(
            root
        )
        self.volumes = root / "volumes"
        self.revisions = root / "revisions"
        self.conflicts = root / "conflicts"
        self.provider_states = root / "provider-state"
        self.manifest_path = root / "manifest.json"
        self.database_path = root / "index.sqlite3"
        self.target_bytes = strict_positive_int(
            target_bytes,
            "target_bytes",
        )
        self.maximum_bytes = strict_positive_int(
            maximum_bytes,
            "maximum_bytes",
        )

        if self.target_bytes >= self.maximum_bytes:
            raise ValueError(
                "target_bytes must be below maximum_bytes."
            )

        self._lock = threading.RLock()
        self._closed = False

        for directory in (
            self.volumes,
            self.revisions,
            self.conflicts,
            self.provider_states,
        ):
            directory.mkdir(parents=True, exist_ok=True)

        self.database = sqlite3.connect(
            self.database_path
        )
        self.database.row_factory = sqlite3.Row
        self._initialize_schema()
        self.manifest = read_json(
            self.manifest_path,
            {},
        ) or {
            "schema_version": SCHEMA,
            "generated_at": now(),
            "record_format": "jsonl",
            "target_volume_bytes": target_bytes,
            "maximum_volume_bytes": maximum_bytes,
            "total_primary_records": 0,
            "total_revisions": 0,
            "volumes": [],
            "active_volume": None,
        }
        self._save_manifest()

    def __enter__(
        self,
    ) -> Archive:
        """Return this archive for context-manager use."""

        self._ensure_open()
        return self

    def __exit__(
        self,
        exc_type: Any,
        exc: Any,
        traceback: Any,
    ) -> None:
        """Close the archive when leaving a context."""

        self.close()

    @property
    def closed(
        self,
    ) -> bool:
        """Return whether the archive is closed."""

        return self._closed

    def _ensure_open(
        self,
    ) -> None:
        """Raise when an operation is attempted after close."""

        if self._closed:
            raise RuntimeError(
                "Archive is closed."
            )

    def _initialize_schema(self) -> None:
        self.database.executescript(
            """
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            PRAGMA foreign_keys=ON;
            PRAGMA busy_timeout=30000;

            CREATE TABLE IF NOT EXISTS taxa(
                speciedex_id TEXT PRIMARY KEY,
                identity_key TEXT NOT NULL,
                scientific_name TEXT NOT NULL,
                canonical_name TEXT NOT NULL,
                rank TEXT NOT NULL,
                status TEXT NOT NULL,
                authorship TEXT NOT NULL,
                kingdom TEXT NOT NULL,
                phylum TEXT NOT NULL,
                class_name TEXT NOT NULL,
                order_name TEXT NOT NULL,
                family TEXT NOT NULL,
                genus TEXT NOT NULL,
                record_json TEXT NOT NULL,
                record_hash TEXT NOT NULL,
                volume_file TEXT NOT NULL,
                line_number INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS taxa_identity
            ON taxa(identity_key);

            CREATE INDEX IF NOT EXISTS taxa_name
            ON taxa(canonical_name, rank, kingdom);

            CREATE TABLE IF NOT EXISTS source_ids(
                provider TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                speciedex_id TEXT NOT NULL,
                PRIMARY KEY(provider, provider_id)
            );

            CREATE TABLE IF NOT EXISTS assertions(
                provider TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                speciedex_id TEXT NOT NULL,
                assertion_json TEXT NOT NULL,
                assertion_hash TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(provider, provider_id)
            );

            CREATE TABLE IF NOT EXISTS synonyms(
                synonym_key TEXT NOT NULL,
                speciedex_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                PRIMARY KEY(
                    synonym_key,
                    speciedex_id,
                    provider
                )
            );

            CREATE TABLE IF NOT EXISTS conflicts(
                conflict_id TEXT PRIMARY KEY,
                conflict_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        self.database.commit()

    def close(self) -> None:
        """Commit and close the archive idempotently."""

        with self._lock:
            if self._closed:
                return

            self.database.commit()
            self.database.close()
            self._closed = True

    def _save_manifest(self) -> None:
        self.manifest["generated_at"] = now()
        write_json(
            self.manifest_path,
            self.manifest,
        )

    def identity_key(self, record: Taxon) -> str:
        return "|".join(
            [
                normalize_key(record.canonical_name),
                normalize_key(record.rank),
                normalize_key(record.kingdom),
                normalize_key(record.authorship),
            ]
        )

    def speciedex_id(self, identity_key: str) -> str:
        return (
            "spx:sha256:"
            + hashlib.sha256(
                identity_key.encode("utf-8")
            ).hexdigest()
        )

    def value_hash(self, value: Any) -> str:
        return hashlib.sha256(
            json.dumps(
                value,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        ).hexdigest()

    def active_volume(self) -> dict[str, Any]:
        self._ensure_open()
        active_name = self.manifest.get(
            "active_volume"
        )

        for entry in self.manifest["volumes"]:
            if (
                entry["file"] == active_name
                and not entry["sealed"]
            ):
                return entry

        number = 1

        for existing in self.manifest.get(
            "volumes",
            [],
        ):
            match = re.search(
                r"([0-9]{6})\.jsonl$",
                normalize_space(
                    existing.get(
                        "file"
                    )
                ),
            )
            if match:
                number = max(
                    number,
                    int(
                        match.group(
                            1
                        )
                    )
                    + 1,
                )
        entry = {
            "file": (
                f"volumes/species-{number:06d}.jsonl"
            ),
            "record_count": 0,
            "size_bytes": 0,
            "sha256": None,
            "sealed": False,
            "created_at": now(),
            "sealed_at": None,
        }
        self.manifest["volumes"].append(entry)
        self.manifest["active_volume"] = entry["file"]
        self._save_manifest()
        return entry

    def seal_if_needed(
        self,
        entry: dict[str, Any],
    ) -> None:
        self._ensure_open()
        path = self.root / entry["file"]
        entry["size_bytes"] = (
            path.stat().st_size if path.exists() else 0
        )

        if entry["size_bytes"] >= self.target_bytes:
            entry["sealed"] = True
            entry["sealed_at"] = now()
            entry["sha256"] = file_hash(path)
            self.manifest["active_volume"] = None

        self._save_manifest()

    def source_match(
        self,
        provider: str,
        provider_id: str,
    ) -> str | None:
        self._ensure_open()
        row = self.database.execute(
            """
            SELECT speciedex_id
            FROM source_ids
            WHERE provider = ?
              AND provider_id = ?
            """,
            (provider, provider_id),
        ).fetchone()
        return (
            str(row["speciedex_id"])
            if row
            else None
        )

    def identity_candidates(
        self,
        identity_key: str,
    ) -> list[sqlite3.Row]:
        self._ensure_open()
        return list(
            self.database.execute(
                """
                SELECT *
                FROM taxa
                WHERE identity_key = ?
                """,
                (identity_key,),
            )
        )

    def name_candidates(
        self,
        record: Taxon,
    ) -> list[sqlite3.Row]:
        self._ensure_open()
        return list(
            self.database.execute(
                """
                SELECT *
                FROM taxa
                WHERE canonical_name = ?
                  AND rank = ?
                  AND kingdom = ?
                """,
                (
                    normalize_key(record.canonical_name),
                    normalize_key(record.rank),
                    normalize_key(record.kingdom),
                ),
            )
        )

    def add_primary(self, record: Taxon) -> str:
        self._ensure_open()
        identity_key = self.identity_key(record)
        identifier = self.speciedex_id(identity_key)
        primary = {
            "schema_version": SCHEMA,
            "speciedex_id": identifier,
            "identity_key": identity_key,
            "canonical_name": record.canonical_name,
            "scientific_name": record.scientific_name,
            "rank": record.rank,
            "status": record.status,
            "authorship": record.authorship,
            "taxonomy": {
                "kingdom": record.kingdom,
                "phylum": record.phylum,
                "class": record.class_name,
                "order": record.order,
                "family": record.family,
                "genus": record.genus,
            },
            "first_seen": (
                record.retrieved_at or now()
            ),
            "initial_source": {
                "provider": record.provider,
                "provider_id": record.provider_id,
                "url": record.source_url,
            },
        }

        entry = self.active_volume()
        path = self.root / entry["file"]
        estimated = len(
            (
                json.dumps(
                    primary,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    sort_keys=True,
                    allow_nan=False,
                )
                + "\n"
            ).encode(
                "utf-8"
            )
        )
        if estimated > self.maximum_bytes:
            raise ValueError(
                "A single primary record exceeds maximum_bytes."
            )

        current_size = (
            path.stat().st_size if path.exists() else 0
        )

        if current_size and (
            current_size + estimated
            > self.maximum_bytes
        ):
            entry["sealed"] = True
            entry["sealed_at"] = now()
            entry["sha256"] = file_hash(path)
            self.manifest["active_volume"] = None
            self._save_manifest()
            entry = self.active_volume()
            path = self.root / entry["file"]

        line_number = entry["record_count"] + 1
        append_jsonl(path, [primary])
        entry["record_count"] = line_number
        entry["size_bytes"] = path.stat().st_size
        self.manifest["total_primary_records"] += 1

        primary_json = json.dumps(
            primary,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
            allow_nan=False,
        )

        self.database.execute(
            """
            INSERT INTO taxa VALUES(
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?
            )
            """,
            (
                identifier,
                identity_key,
                normalize_key(record.scientific_name),
                normalize_key(record.canonical_name),
                normalize_key(record.rank),
                normalize_key(record.status),
                normalize_key(record.authorship),
                normalize_key(record.kingdom),
                normalize_key(record.phylum),
                normalize_key(record.class_name),
                normalize_key(record.order),
                normalize_key(record.family),
                normalize_key(record.genus),
                primary_json,
                self.value_hash(primary),
                entry["file"],
                line_number,
                primary["first_seen"],
                primary["first_seen"],
            ),
        )
        self.attach_assertion(identifier, record)
        self.database.commit()
        self.seal_if_needed(entry)
        return identifier

    def attach_assertion(
        self,
        identifier: str,
        record: Taxon,
    ) -> bool:
        self._ensure_open()
        assertion = record.to_dict()
        assertion_hash = self.value_hash(assertion)
        previous = self.database.execute(
            """
            SELECT assertion_hash
            FROM assertions
            WHERE provider = ?
              AND provider_id = ?
            """,
            (record.provider, record.provider_id),
        ).fetchone()
        changed = bool(
            previous
            and previous["assertion_hash"]
            != assertion_hash
        )

        assertion_json = json.dumps(
            assertion,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
            allow_nan=False,
        )
        timestamp = now()

        self.database.execute(
            """
            INSERT INTO source_ids VALUES(?, ?, ?)
            ON CONFLICT(provider, provider_id)
            DO UPDATE SET
                speciedex_id = excluded.speciedex_id
            """,
            (
                record.provider,
                record.provider_id,
                identifier,
            ),
        )
        self.database.execute(
            """
            INSERT INTO assertions VALUES(
                ?, ?, ?, ?, ?, ?
            )
            ON CONFLICT(provider, provider_id)
            DO UPDATE SET
                speciedex_id = excluded.speciedex_id,
                assertion_json = excluded.assertion_json,
                assertion_hash = excluded.assertion_hash,
                updated_at = excluded.updated_at
            """,
            (
                record.provider,
                record.provider_id,
                identifier,
                assertion_json,
                assertion_hash,
                timestamp,
            ),
        )

        for synonym in record.synonyms:
            key = normalize_key(synonym)
            if key:
                self.database.execute(
                    """
                    INSERT OR IGNORE INTO synonyms
                    VALUES(?, ?, ?)
                    """,
                    (
                        key,
                        identifier,
                        record.provider,
                    ),
                )

        if changed:
            volume = (
                self.manifest["total_revisions"]
                // 100000
                + 1
            )
            append_jsonl(
                self.revisions
                / f"revisions-{volume:06d}.jsonl",
                [
                    {
                        "schema_version": SCHEMA,
                        "event": (
                            "provider_assertion_changed"
                        ),
                        "speciedex_id": identifier,
                        "provider": record.provider,
                        "provider_id": record.provider_id,
                        "changed_at": timestamp,
                        "assertion": assertion,
                    }
                ],
            )
            self.manifest["total_revisions"] += 1
            self._save_manifest()

        self.database.commit()
        return changed

    def add_conflict(
        self,
        record: Taxon,
        candidates: list[str],
        reason: str,
    ) -> None:
        self._ensure_open()
        conflict = {
            "provider": record.provider,
            "provider_id": record.provider_id,
            "canonical_name": record.canonical_name,
            "rank": record.rank,
            "kingdom": record.kingdom,
            "candidates": candidates,
            "reason": reason,
            "created_at": now(),
        }
        conflict_id = self.value_hash(conflict)
        conflict["conflict_id"] = conflict_id

        self.database.execute(
            """
            INSERT OR IGNORE INTO conflicts
            VALUES(?, ?, ?)
            """,
            (
                conflict_id,
                json.dumps(
                    conflict,
                    ensure_ascii=False,
                    sort_keys=True,
                    allow_nan=False,
                ),
                conflict["created_at"],
            ),
        )
        append_jsonl(
            self.conflicts / "unresolved.jsonl",
            [conflict],
        )
        self.database.commit()

    def rebuild_index(self) -> dict[str, int]:
        """Rebuild the derived SQLite index from canonical JSONL volumes.

        The append-only volume archive is authoritative.  SQLite is only a
        disposable derived index and may be absent, stale, empty, or corrupt.
        This method reconstructs the complete index in a temporary database,
        validates it, and atomically replaces the old database.
        """

        self._ensure_open()

        with self._lock:
            temporary_path = self.root / (
                f".{self.database_path.name}.rebuild-{os.getpid()}.tmp"
            )
            temporary_path.unlink(missing_ok=True)

            self.database.commit()
            self.database.close()

            rebuilt = sqlite3.connect(temporary_path)
            rebuilt.row_factory = sqlite3.Row
            original_database = self.database
            self.database = rebuilt

            inserted_taxa = 0
            inserted_sources = 0
            inserted_assertions = 0
            inserted_conflicts = 0

            try:
                self._initialize_schema()
                rebuilt.execute("BEGIN IMMEDIATE")

                for entry in self.manifest.get("volumes", []):
                    relative_file = normalize_space(entry.get("file"))
                    if not relative_file:
                        raise ValueError("Manifest volume entry has no file.")

                    volume_path = self.root / relative_file
                    if not volume_path.is_file():
                        raise FileNotFoundError(
                            f"Missing canonical volume: {relative_file}"
                        )

                    with volume_path.open("r", encoding="utf-8") as handle:
                        for line_number, line in enumerate(handle, start=1):
                            if not line.strip():
                                continue

                            try:
                                primary = json.loads(line)
                            except json.JSONDecodeError as error:
                                raise ValueError(
                                    "Invalid canonical JSONL at "
                                    f"{relative_file}:{line_number}: {error.msg}"
                                ) from error

                            if not isinstance(primary, dict):
                                raise ValueError(
                                    "Canonical JSONL value is not an object at "
                                    f"{relative_file}:{line_number}."
                                )

                            identifier = normalize_space(
                                primary.get("speciedex_id")
                            )
                            if not SPECIEDEX_ID_PATTERN.fullmatch(identifier):
                                raise ValueError(
                                    "Invalid Speciedex ID at "
                                    f"{relative_file}:{line_number}: "
                                    f"{identifier!r}."
                                )

                            taxonomy = primary.get("taxonomy")
                            if not isinstance(taxonomy, dict):
                                taxonomy = {}

                            canonical_name = normalize_space(
                                primary.get("canonical_name")
                            )
                            scientific_name = normalize_space(
                                primary.get("scientific_name")
                            ) or canonical_name
                            rank = normalize_rank(primary.get("rank"))
                            status = normalize_status(primary.get("status"))
                            authorship = normalize_space(
                                primary.get("authorship")
                            )
                            kingdom = normalize_space(taxonomy.get("kingdom"))
                            phylum = normalize_space(taxonomy.get("phylum"))
                            class_name = normalize_space(taxonomy.get("class"))
                            order_name = normalize_space(taxonomy.get("order"))
                            family = normalize_space(taxonomy.get("family"))
                            genus = normalize_space(taxonomy.get("genus"))

                            identity_key = normalize_space(
                                primary.get("identity_key")
                            ) or "|".join(
                                (
                                    normalize_key(canonical_name),
                                    normalize_key(rank),
                                    normalize_key(kingdom),
                                    normalize_key(authorship),
                                )
                            )

                            expected_identifier = self.speciedex_id(identity_key)
                            if identifier != expected_identifier:
                                raise ValueError(
                                    "Speciedex ID does not match identity key at "
                                    f"{relative_file}:{line_number}."
                                )

                            timestamp = normalize_space(
                                primary.get("first_seen")
                            ) or now()
                            primary_json = json.dumps(
                                primary,
                                ensure_ascii=False,
                                separators=(",", ":"),
                                sort_keys=True,
                                allow_nan=False,
                            )

                            rebuilt.execute(
                                """
                                INSERT INTO taxa VALUES(
                                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                                    ?, ?, ?, ?, ?, ?, ?, ?
                                )
                                """,
                                (
                                    identifier,
                                    identity_key,
                                    normalize_key(scientific_name),
                                    normalize_key(canonical_name),
                                    normalize_key(rank),
                                    normalize_key(status),
                                    normalize_key(authorship),
                                    normalize_key(kingdom),
                                    normalize_key(phylum),
                                    normalize_key(class_name),
                                    normalize_key(order_name),
                                    normalize_key(family),
                                    normalize_key(genus),
                                    primary_json,
                                    self.value_hash(primary),
                                    relative_file,
                                    line_number,
                                    timestamp,
                                    timestamp,
                                ),
                            )
                            inserted_taxa += 1

                            initial_source = primary.get("initial_source")
                            if isinstance(initial_source, dict):
                                provider = normalize_key(
                                    initial_source.get("provider")
                                )
                                provider_id = normalize_space(
                                    initial_source.get("provider_id")
                                )
                                if provider and provider_id:
                                    assertion = {
                                        "provider": provider,
                                        "provider_id": provider_id,
                                        "speciedex_id": identifier,
                                        "scientific_name": scientific_name,
                                        "canonical_name": canonical_name,
                                        "rank": rank,
                                        "status": status,
                                        "authorship": authorship,
                                        "taxonomy": taxonomy,
                                        "source_url": normalize_space(
                                            initial_source.get("url")
                                        ),
                                        "retrieved_at": timestamp,
                                        "reconstructed_from": "primary-volume",
                                    }
                                    assertion_json = json.dumps(
                                        assertion,
                                        ensure_ascii=False,
                                        separators=(",", ":"),
                                        sort_keys=True,
                                        allow_nan=False,
                                    )
                                    cursor = rebuilt.execute(
                                        """
                                        INSERT OR IGNORE INTO source_ids
                                        VALUES(?, ?, ?)
                                        """,
                                        (provider, provider_id, identifier),
                                    )
                                    inserted_sources += max(cursor.rowcount, 0)
                                    cursor = rebuilt.execute(
                                        """
                                        INSERT OR IGNORE INTO assertions
                                        VALUES(?, ?, ?, ?, ?, ?)
                                        """,
                                        (
                                            provider,
                                            provider_id,
                                            identifier,
                                            assertion_json,
                                            self.value_hash(assertion),
                                            timestamp,
                                        ),
                                    )
                                    inserted_assertions += max(cursor.rowcount, 0)

                unresolved_path = self.conflicts / "unresolved.jsonl"
                if unresolved_path.is_file():
                    with unresolved_path.open("r", encoding="utf-8") as handle:
                        for line_number, line in enumerate(handle, start=1):
                            if not line.strip():
                                continue
                            conflict = json.loads(line)
                            if not isinstance(conflict, dict):
                                raise ValueError(
                                    "Conflict JSONL value is not an object at "
                                    f"{unresolved_path}:{line_number}."
                                )
                            conflict_id = normalize_space(
                                conflict.get("conflict_id")
                            ) or self.value_hash(conflict)
                            created_at = normalize_space(
                                conflict.get("created_at")
                            ) or now()
                            cursor = rebuilt.execute(
                                """
                                INSERT OR IGNORE INTO conflicts
                                VALUES(?, ?, ?)
                                """,
                                (
                                    conflict_id,
                                    json.dumps(
                                        conflict,
                                        ensure_ascii=False,
                                        separators=(",", ":"),
                                        sort_keys=True,
                                        allow_nan=False,
                                    ),
                                    created_at,
                                ),
                            )
                            inserted_conflicts += max(cursor.rowcount, 0)

                expected = safe_int(
                    self.manifest.get("total_primary_records"),
                    -1,
                )
                if inserted_taxa != expected:
                    raise ValueError(
                        "Rebuilt SQLite record count does not match manifest: "
                        f"sqlite={inserted_taxa}, manifest={expected}."
                    )

                rebuilt.commit()
                integrity = rebuilt.execute("PRAGMA integrity_check").fetchone()[0]
                if integrity != "ok":
                    raise ValueError(
                        f"Rebuilt SQLite integrity check failed: {integrity}."
                    )
                rebuilt.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                rebuilt.commit()
                rebuilt.close()

                for suffix in ("-wal", "-shm", "-journal"):
                    Path(str(self.database_path) + suffix).unlink(missing_ok=True)
                temporary_path.replace(self.database_path)

                self.database = sqlite3.connect(self.database_path)
                self.database.row_factory = sqlite3.Row
                self._initialize_schema()

                return {
                    "taxa": inserted_taxa,
                    "source_ids": inserted_sources,
                    "assertions": inserted_assertions,
                    "conflicts": inserted_conflicts,
                }
            except Exception:
                try:
                    rebuilt.rollback()
                except sqlite3.Error:
                    pass
                try:
                    rebuilt.close()
                except sqlite3.Error:
                    pass
                temporary_path.unlink(missing_ok=True)
                self.database = sqlite3.connect(self.database_path)
                self.database.row_factory = sqlite3.Row
                self._initialize_schema()
                raise

    def statistics(self) -> dict[str, Any]:
        """Return canonical counts, including lineage-derived higher ranks."""
        self._ensure_open()

        active = tuple(sorted(ACTIVE_STATUSES))
        placeholders = ",".join("?" for _ in active)

        def count_primary_rank(rank: str) -> int:
            row = self.database.execute(
                "SELECT COUNT(DISTINCT speciedex_id) AS count "
                "FROM taxa WHERE rank = ? "
                f"AND status IN ({placeholders})",
                (rank, *active),
            ).fetchone()
            return int(row["count"])

        def count_lineage_rank(column: str, rank: str) -> int:
            # Count names represented either as canonical records of this rank
            # or as non-empty lineage values attached to lower-rank records.
            query = f"""
                SELECT COUNT(DISTINCT name) AS count
                FROM (
                    SELECT canonical_name AS name
                    FROM taxa
                    WHERE rank = ?
                      AND status IN ({placeholders})
                      AND canonical_name <> ''
                    UNION
                    SELECT {column} AS name
                    FROM taxa
                    WHERE status IN ({placeholders})
                      AND {column} <> ''
                )
            """
            row = self.database.execute(
                query,
                (rank, *active, *active),
            ).fetchone()
            return int(row["count"])

        result: dict[str, Any] = {
            "species": count_primary_rank("species"),
            "subspecies": count_primary_rank("subspecies"),
            "genera": count_lineage_rank("genus", "genus"),
            "families": count_lineage_rank("family", "family"),
            "orders": count_lineage_rank("order_name", "order"),
            "classes": count_lineage_rank("class_name", "class"),
            "phyla": count_lineage_rank("phylum", "phylum"),
            "kingdoms": count_lineage_rank("kingdom", "kingdom"),
        }

        # Compatibility aliases for clients that use singular keys.
        result.update({
            "genus": result["genera"],
            "family": result["families"],
            "order": result["orders"],
            "class": result["classes"],
            "phylum": result["phyla"],
            "kingdom": result["kingdoms"],
        })

        result["rank_counts"] = {
            row["rank"]: int(row["count"])
            for row in self.database.execute(
                "SELECT rank, COUNT(DISTINCT speciedex_id) AS count "
                "FROM taxa WHERE status IN ("
                + placeholders
                + ") GROUP BY rank ORDER BY rank",
                active,
            )
            if row["rank"]
        }
        result["records_archived"] = int(
            self.database.execute(
                "SELECT COUNT(*) AS count FROM taxa"
            ).fetchone()["count"]
        )
        result["source_assertions"] = int(
            self.database.execute(
                "SELECT COUNT(*) AS count FROM assertions"
            ).fetchone()["count"]
        )
        result["synonyms"] = int(
            self.database.execute(
                "SELECT COUNT(*) AS count FROM synonyms"
            ).fetchone()["count"]
        )
        result["unresolved_conflicts"] = int(
            self.database.execute(
                "SELECT COUNT(*) AS count FROM conflicts"
            ).fetchone()["count"]
        )
        result["volumes"] = len(self.manifest["volumes"])
        return result

    def verify(self) -> list[str]:
        """Verify archive volumes and manifest totals."""

        self._ensure_open()
        errors: list[str] = []
        total_records = 0
        seen_files: set[str] = set()

        for entry in self.manifest.get(
            "volumes",
            [],
        ):
            relative_file = normalize_space(
                entry.get(
                    "file"
                )
            )

            if not relative_file:
                errors.append(
                    "Manifest volume entry has no file."
                )
                continue

            if relative_file in seen_files:
                errors.append(
                    f"Duplicate manifest volume: {relative_file}"
                )
                continue

            seen_files.add(
                relative_file
            )
            path = self.root / relative_file

            if not path.exists():
                errors.append(
                    f"Missing volume: {relative_file}"
                )
                continue

            actual_size = path.stat().st_size

            if actual_size != safe_int(
                entry.get(
                    "size_bytes"
                ),
                -1,
            ):
                errors.append(
                    f"Size mismatch: {relative_file}"
                )

            actual_records = 0

            with path.open(
                "r",
                encoding="utf-8",
            ) as handle:
                for line_number, line in enumerate(
                    handle,
                    start=1,
                ):
                    if not line.strip():
                        continue

                    actual_records += 1

                    try:
                        value = json.loads(
                            line
                        )
                    except json.JSONDecodeError as error:
                        errors.append(
                            "Invalid JSONL: "
                            f"{relative_file}:{line_number}: "
                            f"{error.msg}"
                        )
                        continue

                    if not isinstance(
                        value,
                        dict,
                    ):
                        errors.append(
                            "JSONL value is not an object: "
                            f"{relative_file}:{line_number}"
                        )

            expected_records = safe_int(
                entry.get(
                    "record_count"
                ),
                -1,
            )

            if actual_records != expected_records:
                errors.append(
                    f"Record count mismatch: {relative_file}"
                )

            total_records += actual_records

            if entry.get(
                "sealed"
            ):
                expected_hash = normalize_space(
                    entry.get(
                        "sha256"
                    )
                )

                if not re.fullmatch(
                    r"[0-9a-f]{64}",
                    expected_hash,
                ):
                    errors.append(
                        f"Invalid hash format: {relative_file}"
                    )
                elif file_hash(
                    path
                ) != expected_hash:
                    errors.append(
                        f"Hash mismatch: {relative_file}"
                    )

        manifest_total = safe_int(
            self.manifest.get(
                "total_primary_records"
            ),
            -1,
        )

        if total_records != manifest_total:
            errors.append(
                "Manifest total_primary_records mismatch: "
                f"manifest={manifest_total}, "
                f"actual={total_records}"
            )

        database_total = int(
            self.database.execute(
                "SELECT COUNT(*) FROM taxa"
            ).fetchone()[0]
        )

        if database_total != total_records:
            errors.append(
                "SQLite taxa count mismatch: "
                f"database={database_total}, "
                f"volumes={total_records}"
            )

        return errors


def score_candidate(
    record: Taxon,
    row: sqlite3.Row,
) -> int:
    score = 0

    if (
        normalize_key(record.canonical_name)
        == row["canonical_name"]
    ):
        score += 35

    if (
        normalize_key(record.authorship)
        and normalize_key(record.authorship)
        == row["authorship"]
    ):
        score += 20

    if normalize_key(record.rank) == row["rank"]:
        score += 10

    if (
        normalize_key(record.kingdom)
        and normalize_key(record.kingdom)
        == row["kingdom"]
    ):
        score += 15

    parent_matches = sum(
        1
        for value, column in (
            (record.phylum, "phylum"),
            (record.class_name, "class_name"),
            (record.order, "order_name"),
            (record.family, "family"),
            (record.genus, "genus"),
        )
        if normalize_key(value)
        and normalize_key(value) == row[column]
    )
    score += min(parent_matches * 4, 20)
    return score


def resolve(
    archive: Archive,
    record: Taxon,
) -> tuple[str, str | None, list[str], str]:
    direct = archive.source_match(
        record.provider,
        record.provider_id,
    )
    if direct:
        return (
            "match",
            direct,
            [direct],
            "source identifier",
        )

    identity_key = archive.identity_key(record)
    exact = archive.identity_candidates(
        identity_key
    )

    if len(exact) == 1:
        identifier = str(exact[0]["speciedex_id"])
        return (
            "match",
            identifier,
            [identifier],
            "exact identity",
        )

    if len(exact) > 1:
        identifiers = [
            str(row["speciedex_id"])
            for row in exact
        ]
        return (
            "conflict",
            None,
            identifiers,
            "duplicate exact identity",
        )

    scored = sorted(
        [
            (
                score_candidate(record, row),
                str(row["speciedex_id"]),
            )
            for row in archive.name_candidates(record)
        ],
        reverse=True,
    )

    if not scored:
        return ("create", None, [], "new identity")

    best_score = scored[0][0]
    best_identifiers = [
        identifier
        for score, identifier in scored
        if score == best_score
    ]

    if best_score >= 75 and len(best_identifiers) == 1:
        return (
            "match",
            best_identifiers[0],
            best_identifiers,
            "high-confidence taxonomy match",
        )

    if best_score >= 50:
        return (
            "conflict",
            None,
            best_identifiers,
            "ambiguous taxonomy match",
        )

    return (
        "create",
        None,
        best_identifiers,
        "candidate confidence below threshold",
    )


def provider_available(
    definition: dict[str, Any],
) -> tuple[bool, str]:
    if not isinstance(
        definition,
        dict,
    ):
        return (
            False,
            "provider definition is not an object",
        )

    try:
        provider_name = safe_provider_name(
            definition.get(
                "name"
            )
        )
    except ValueError as error:
        return (
            False,
            str(
                error
            ),
        )

    if not definition.get("enabled", True):
        return (False, "disabled")

    missing = [
        str(name)
        for name in definition.get(
            "required_env",
            [],
        )
        if not os.getenv(str(name))
    ]
    if missing:
        return (
            False,
            "missing environment: "
            + ", ".join(missing),
        )

    module_path = (
        TOOLS_ROOT
        / "providers"
        / f"{provider_name}.py"
    )
    if not module_path.exists():
        return (
            False,
            f"missing module: {module_path.name}",
        )

    adapter = str(definition.get("adapter", "")).strip().lower()
    if adapter == "file_jsonl":
        configured_text = str(definition.get("path", "")).strip()
        if not configured_text:
            return (False, "missing configured path")
        configured = Path(configured_text)
        dataset = (
            configured
            if configured.is_absolute()
            else REPO_ROOT / configured
        )
        if not dataset.is_file():
            return (
                False,
                f"missing dataset: {dataset}",
            )

    return (True, "")


def parse_arguments(
    argv: list[str] | None = None,
) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="stat-grabber.py",
        description=(
            "Ingest, reconcile, archive, and count "
            "multi-source taxonomic records."
        ),
    )
    parser.add_argument(
        "command",
        nargs="?",
        choices=(
            "scan",
            "verify",
            "providers",
            "reindex",
        ),
        default="scan",
    )
    parser.add_argument(
        "--registry",
        default=str(
            TOOLS_ROOT / "providers.json"
        ),
    )
    parser.add_argument(
        "--data-root",
        default=str(
            REPO_ROOT / "static" / "data"
        ),
    )
    parser.add_argument(
        "--provider",
        action="append",
        default=[],
    )
    parser.add_argument(
        "--all-providers",
        action="store_true",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=500,
    )
    parser.add_argument(
        "--provider-budget",
        type=int,
        default=4,
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=4,
    )
    parser.add_argument(
        "--backoff",
        type=float,
        default=2.0,
    )
    parser.add_argument(
        "--volume-target-mb",
        type=int,
        default=48,
    )
    parser.add_argument(
        "--volume-max-mb",
        type=int,
        default=90,
    )
    parser.add_argument(
        "--history-limit",
        type=int,
        default=672,
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
    )
    return parser.parse_args(
        argv
    )


def main(
    argv: list[str] | None = None,
) -> int:
    args = parse_arguments(
        argv
    )

    logging.basicConfig(
        level=(
            logging.DEBUG
            if args.verbose
            else logging.INFO
        ),
        format=(
            "%(asctime)s %(levelname)s %(message)s"
        ),
    )

    for option_name, option_value in (
        ("--batch-size", args.batch_size),
        ("--provider-budget", args.provider_budget),
        ("--timeout", args.timeout),
        ("--retries", args.retries),
        ("--volume-target-mb", args.volume_target_mb),
        ("--volume-max-mb", args.volume_max_mb),
    ):
        if option_value < 1:
            raise SystemExit(
                f"{option_name} must be positive"
            )

    if args.backoff < 0:
        raise SystemExit(
            "--backoff must be non-negative"
        )

    if (
        args.volume_target_mb
        >= args.volume_max_mb
    ):
        raise SystemExit(
            "--volume-target-mb must be below "
            "--volume-max-mb"
        )

    data_root = Path(args.data_root)
    registry = read_json(
        Path(args.registry),
        {},
    )
    if not isinstance(
        registry,
        dict,
    ):
        raise SystemExit(
            "providers.json root must be an object"
        )

    definitions = registry.get("providers", [])

    if not isinstance(definitions, list):
        raise SystemExit(
            "providers.json does not contain "
            "a providers list"
        )

    archive = Archive(
        data_root / "taxonomy",
        args.volume_target_mb * 1024 * 1024,
        args.volume_max_mb * 1024 * 1024,
    )
    http = HTTPClient(
        timeout=args.timeout,
        retries=args.retries,
        backoff=args.backoff,
        user_agent=(
            f"Speciedex.org-StatGrabber/{VERSION} "
            "(https://speciedex.org)"
        ),
    )

    try:
        if args.command == "verify":
            errors = archive.verify()
            for error in errors:
                print(error, file=sys.stderr)
            return 1 if errors else 0

        requested = {
            safe_provider_name(
                name
            )
            for name in args.provider
        }
        eligible: list[dict[str, Any]] = []
        skipped: list[dict[str, str]] = []

        for definition in definitions:
            try:
                name = safe_provider_name(
                    definition.get(
                        "name"
                    )
                )
            except (
                AttributeError,
                ValueError,
            ):
                skipped.append(
                    {
                        "provider": normalize_space(
                            getattr(
                                definition,
                                "get",
                                lambda *_: "",
                            )(
                                "name",
                                "",
                            )
                        ),
                        "reason": (
                            "invalid provider definition"
                        ),
                    }
                )
                continue

            if requested and name not in requested:
                continue

            available, reason = provider_available(
                definition
            )
            if available:
                eligible.append(definition)
            else:
                skipped.append(
                    {
                        "provider": name,
                        "reason": reason,
                    }
                )

        discovered_names = {
            normalize_key(
                definition.get(
                    "name"
                )
            )
            for definition in definitions
            if isinstance(
                definition,
                dict,
            )
        }
        missing_requested = sorted(
            requested - discovered_names
        )

        for name in missing_requested:
            skipped.append(
                {
                    "provider": name,
                    "reason": "not registered",
                }
            )

        if args.command == "providers":
            print(
                json.dumps(
                    {
                        "eligible": [
                            definition["name"]
                            for definition in eligible
                        ],
                        "skipped": skipped,
                    },
                    indent=2,
                )
            )
            return 0

        if args.command == "reindex":
            rebuilt = archive.rebuild_index()
            statistics = {
                **archive.statistics(),
                "last_updated": now(),
                "count_method": (
                    "local-deduplicated-append-only-"
                    "canonical-corpus"
                ),
                "generator": {
                    "name": NAME,
                    "version": VERSION,
                },
                "reindex": rebuilt,
            }
            write_json(
                data_root / "statistics.json",
                statistics,
            )
            print(
                "Rebuilt SQLite index: "
                f"taxa={rebuilt['taxa']}, "
                f"source_ids={rebuilt['source_ids']}, "
                f"assertions={rebuilt['assertions']}, "
                f"conflicts={rebuilt['conflicts']}"
            )
            return 0

        scheduler_path = (
            data_root
            / "taxonomy"
            / "scheduler.json"
        )
        scheduler = read_json(
            scheduler_path,
            {},
        )
        cursor = safe_int(
            scheduler.get("cursor"),
            0,
        )

        if (
            args.all_providers
            or requested
        ):
            selected = eligible
        elif eligible:
            budget = min(
                args.provider_budget,
                len(eligible),
            )
            selected = [
                eligible[
                    (cursor + index)
                    % len(eligible)
                ]
                for index in range(budget)
            ]
            write_json(
                scheduler_path,
                {
                    "cursor": (
                        cursor + budget
                    ) % len(eligible),
                    "updated_at": now(),
                    "registered": len(definitions),
                    "eligible": len(eligible),
                },
            )
        else:
            selected = []

        summaries: list[dict[str, Any]] = []

        for definition in selected:
            name = safe_provider_name(
                definition["name"]
            )
            state_path = (
                archive.provider_states
                / f"{name}.json"
            )
            summary = {
                "provider": name,
                "fetched": 0,
                "created": 0,
                "matched": 0,
                "revised": 0,
                "conflicted": 0,
                "rejected": 0,
                "requests": 0,
                "error": None,
            }

            provider = None
            try:
                provider = load_provider(
                    definition,
                    http,
                    state_path,
                    args.batch_size,
                    REPO_ROOT,
                )
                batch = provider.fetch()
                summary["fetched"] = len(
                    batch.records
                )
                summary["requests"] = batch.requests

                for record in batch.records:
                    record = normalize_taxon_record(record)
                    if (
                        not record.provider_id
                        or not record.scientific_name
                    ):
                        summary["rejected"] += 1
                        continue

                    (
                        action,
                        identifier,
                        candidates,
                        reason,
                    ) = resolve(archive, record)

                    if action == "match":
                        summary["matched"] += 1
                        changed = archive.attach_assertion(
                            identifier or "",
                            record,
                        )
                        summary["revised"] += int(
                            changed
                        )
                    elif action == "create":
                        archive.add_primary(record)
                        summary["created"] += 1
                    else:
                        archive.add_conflict(
                            record,
                            candidates,
                            reason,
                        )
                        summary["conflicted"] += 1

                provider.save_success(batch)

            except Exception as error:
                summary["error"] = str(error)
                LOG.exception(
                    "Provider failed: %s",
                    name,
                )
                try:
                    if provider is not None:
                        provider.save_failure(error)
                except Exception:
                    LOG.exception(
                        "Unable to save failure state "
                        "for %s",
                        name,
                    )

            summaries.append(summary)

        statistics = {
            **archive.statistics(),
            "last_updated": now(),
            "count_method": (
                "local-deduplicated-append-only-"
                "canonical-corpus"
            ),
            "generator": {
                "name": NAME,
                "version": VERSION,
            },
        }
        write_json(
            data_root / "statistics.json",
            statistics,
        )
        write_json(
            data_root
            / "statistics-sources.json",
            {
                "generated_at": now(),
                "providers": summaries,
                "skipped": skipped,
            },
        )

        history_path = (
            data_root
            / "statistics-history.json"
        )
        history = read_json(history_path, [])
        if not isinstance(history, list):
            history = []

        snapshot = {
            key: statistics.get(key)
            for key in (
                "last_updated",
                "species",
                "genera",
                "families",
                "orders",
                "classes",
                "phyla",
                "kingdoms",
                "records_archived",
                "source_assertions",
                "unresolved_conflicts",
            )
        }
        comparison_keys = [
            key
            for key in snapshot
            if key != "last_updated"
        ]

        if history and all(
            history[-1].get(key)
            == snapshot.get(key)
            for key in comparison_keys
        ):
            history[-1] = snapshot
        else:
            history.append(snapshot)

        if args.history_limit > 0:
            history = history[
                -args.history_limit:
            ]

        write_json(history_path, history)

        for summary in summaries:
            status = (
                "FAILED"
                if summary["error"]
                else "OK"
            )
            print(
                f"{status:<7} "
                f"{summary['provider']:<24} "
                f"fetched={summary['fetched']:<6} "
                f"created={summary['created']:<6} "
                f"matched={summary['matched']:<6} "
                f"revised={summary['revised']:<6} "
                f"conflicts={summary['conflicted']:<6}"
            )

        failures = [
            summary
            for summary in summaries
            if summary["error"]
        ]
        return (
            1
            if summaries
            and len(failures) == len(summaries)
            else 0
        )
    finally:
        archive.close()


if __name__ == "__main__":
    raise SystemExit(main())

__all__ = [
    "ACTIVE_STATUSES",
    "Archive",
    "LOG",
    "NAME",
    "RANKS",
    "RANK_ALIASES",
    "SAFE_PROVIDER_NAME_PATTERN",
    "SCHEMA",
    "SPECIEDEX_ID_PATTERN",
    "STATUS_ALIASES",
    "TOOLS_ROOT",
    "VERSION",
    "append_jsonl",
    "file_hash",
    "main",
    "normalize_key",
    "normalize_rank",
    "normalize_space",
    "normalize_status",
    "normalize_taxon_record",
    "now",
    "parse_arguments",
    "provider_available",
    "read_json",
    "resolve",
    "safe_int",
    "safe_provider_name",
    "score_candidate",
    "strict_positive_int",
    "write_json",
]
