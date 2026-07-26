#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/synonym_index.py

Taxonomic synonym index and synonym-resolution manager.

This module owns:

- normalized synonym keys,
- synonym-to-Speciedex mappings,
- provider-specific synonym assertions,
- accepted-name references,
- synonym replacement and deduplication,
- synonym candidate lookup,
- ambiguity detection,
- synonym statistics,
- synonym verification,
- synonym index rebuilding,
- compatibility wrappers for Archive and SQLiteIndex.

The SQLite database remains the rebuildable lookup index. Provider assertions
and canonical archive records remain the durable source data.

Copyright (c) 2026 ZZX-Laboratories

Licensed under the MIT License.
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
import threading
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator, Mapping, Sequence

from providers.common import Taxon

from .sqlite_index import SQLiteIndex, SQLiteIndexError
from .taxonomy import (
    canonical_name,
    normalize_authorship,
    normalize_key,
    normalize_rank,
    normalize_status,
    normalize_synonyms,
    normalize_taxon_name,
)


SYNONYM_SCHEMA_VERSION = 1

DEFAULT_MAX_CANDIDATES = 100
MAX_METADATA_JSON_BYTES = 1_048_576
MAX_SOURCE_TEXT_LENGTH = 8192

SYNONYM_LIKE_STATUSES = {
    "synonym",
    "unaccepted",
    "invalid",
    "misapplied",
    "superseded",
    "deprecated",
}

ACCEPTED_LIKE_STATUSES = {
    "accepted",
    "valid",
    "provisionally accepted",
    "reference",
}


class SynonymIndexError(RuntimeError):
    """Raised when synonym indexing cannot complete safely."""


@dataclass(slots=True, frozen=True)
class SynonymAssertion:
    """One normalized synonym assertion."""

    synonym: str
    synonym_key: str
    speciedex_id: str
    provider: str
    provider_id: str = ""
    accepted_provider_id: str = ""
    scientific_name: str = ""
    canonical_name: str = ""
    authorship: str = ""
    rank: str = ""
    status: str = ""
    source_url: str = ""
    source_modified: str = ""
    metadata: dict[str, Any] = field(
        default_factory=dict
    )

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible synonym assertion."""

        return {
            "schema_version": (
                SYNONYM_SCHEMA_VERSION
            ),
            "synonym": self.synonym,
            "synonym_key": self.synonym_key,
            "speciedex_id": self.speciedex_id,
            "provider": self.provider,
            "provider_id": self.provider_id,
            "accepted_provider_id": (
                self.accepted_provider_id
            ),
            "scientific_name": (
                self.scientific_name
            ),
            "canonical_name": (
                self.canonical_name
            ),
            "authorship": self.authorship,
            "rank": self.rank,
            "status": self.status,
            "source_url": self.source_url,
            "source_modified": (
                self.source_modified
            ),
            "metadata": dict(
                self.metadata
            ),
        }


@dataclass(slots=True)
class SynonymCandidate:
    """One canonical taxon candidate returned for a synonym."""

    speciedex_id: str
    synonym: str
    synonym_key: str
    providers: list[str]
    provider_count: int
    canonical_name: str = ""
    scientific_name: str = ""
    rank: str = ""
    status: str = ""
    kingdom: str = ""
    family: str = ""
    genus: str = ""
    confidence: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible candidate."""

        return {
            "speciedex_id": self.speciedex_id,
            "synonym": self.synonym,
            "synonym_key": self.synonym_key,
            "providers": list(
                self.providers
            ),
            "provider_count": (
                self.provider_count
            ),
            "canonical_name": (
                self.canonical_name
            ),
            "scientific_name": (
                self.scientific_name
            ),
            "rank": self.rank,
            "status": self.status,
            "kingdom": self.kingdom,
            "family": self.family,
            "genus": self.genus,
            "confidence": round(
                self.confidence,
                6,
            ),
        }


@dataclass(slots=True)
class SynonymLookup:
    """Result of resolving one synonym string."""

    query: str
    query_key: str
    candidates: list[
        SynonymCandidate
    ]
    exact: bool
    ambiguous: bool

    @property
    def resolved(
        self,
    ) -> SynonymCandidate | None:
        """Return the unique candidate when unambiguous."""

        if (
            self.ambiguous
            or len(self.candidates) != 1
        ):
            return None

        return self.candidates[0]

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible lookup result."""

        return {
            "query": self.query,
            "query_key": self.query_key,
            "exact": self.exact,
            "ambiguous": self.ambiguous,
            "resolved": (
                self.resolved.to_dict()
                if self.resolved is not None
                else None
            ),
            "candidates": [
                candidate.to_dict()
                for candidate
                in self.candidates
            ],
        }


@dataclass(slots=True)
class SynonymStatistics:
    """Aggregate synonym-index statistics."""

    rows: int
    unique_synonyms: int
    canonical_taxa: int
    providers: int
    ambiguous_synonyms: int
    provider_counts: dict[str, int]
    rank_counts: dict[str, int]

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible statistics object."""

        return {
            "rows": self.rows,
            "unique_synonyms": (
                self.unique_synonyms
            ),
            "canonical_taxa": (
                self.canonical_taxa
            ),
            "providers": self.providers,
            "ambiguous_synonyms": (
                self.ambiguous_synonyms
            ),
            "provider_counts": dict(
                self.provider_counts
            ),
            "rank_counts": dict(
                self.rank_counts
            ),
        }


@dataclass(slots=True)
class SynonymVerification:
    """Verification result for the synonym index."""

    valid: bool
    errors: list[str] = field(
        default_factory=list
    )
    warnings: list[str] = field(
        default_factory=list
    )
    rows: int = 0
    orphaned_rows: int = 0
    empty_keys: int = 0
    duplicate_rows: int = 0
    assertion_orphans: int = 0
    unmatched_base_rows: int = 0
    invalid_normalization: int = 0

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible verification result."""

        return {
            "valid": self.valid,
            "errors": list(
                self.errors
            ),
            "warnings": list(
                self.warnings
            ),
            "rows": self.rows,
            "orphaned_rows": (
                self.orphaned_rows
            ),
            "empty_keys": self.empty_keys,
            "duplicate_rows": (
                self.duplicate_rows
            ),
            "assertion_orphans": (
                self.assertion_orphans
            ),
            "unmatched_base_rows": (
                self.unmatched_base_rows
            ),
            "invalid_normalization": (
                self.invalid_normalization
            ),
        }


def normalize_synonym(
    value: Any,
    *,
    authorship: Any = "",
    rank: Any = "",
) -> str:
    """
    Normalize one synonym while preserving scientific-name capitalization.
    """

    name = normalize_taxon_name(
        value
    )

    if not name:
        return ""

    normalized_authorship = (
        normalize_authorship(
            authorship
        )
    )

    normalized_rank = normalize_rank(
        rank
    )

    return canonical_name(
        name,
        authorship=normalized_authorship,
        rank=normalized_rank,
    ) or name


def synonym_key(
    value: Any,
    *,
    authorship: Any = "",
    rank: Any = "",
) -> str:
    """Return the deterministic lookup key for one synonym."""

    normalized = normalize_synonym(
        value,
        authorship=authorship,
        rank=rank,
    )

    return normalize_key(
        normalized
    )


class SynonymIndex:
    """
    SQLite-backed synonym index.

    The class uses the existing ``synonyms`` table for compatibility and may
    add an expanded ``synonym_assertions`` table for richer source metadata.
    """

    def __init__(
        self,
        index: SQLiteIndex,
        *,
        maximum_candidates: int = (
            DEFAULT_MAX_CANDIDATES
        ),
        create_extended_schema: bool = True,
    ) -> None:
        if not isinstance(
            index,
            SQLiteIndex,
        ):
            raise TypeError(
                "index must be a SQLiteIndex."
            )

        self.index = index
        self.maximum_candidates = self._strict_positive_int(
            maximum_candidates,
            "maximum_candidates",
        )
        self._lock = threading.RLock()
        self._closed = False

        if create_extended_schema:
            self._initialize_extended_schema()

    def __enter__(
        self,
    ) -> SynonymIndex:
        self._ensure_open()
        return self

    def __exit__(
        self,
        exc_type: Any,
        exc_value: Any,
        traceback: Any,
    ) -> None:
        self.close()

    @property
    def closed(self) -> bool:
        """Return whether the synonym index wrapper is closed."""

        return self._closed

    def close(self) -> None:
        """Close this wrapper without closing the shared SQLite index."""

        with self._lock:
            self._closed = True

    def _ensure_open(self) -> None:
        if self._closed:
            raise SynonymIndexError(
                "Synonym index is closed."
            )

        if getattr(
            self.index,
            "closed",
            False,
        ):
            raise SynonymIndexError(
                "Underlying SQLite index is closed."
            )

    def _ensure_writable(self) -> None:
        self._ensure_open()

        if self.index.read_only:
            raise SynonymIndexError(
                "Cannot modify a read-only synonym index."
            )

    def configuration(
        self,
    ) -> dict[str, Any]:
        """Return normalized synonym-index configuration."""

        return {
            "maximum_candidates": self.maximum_candidates,
            "schema_version": SYNONYM_SCHEMA_VERSION,
            "read_only": self.index.read_only,
            "closed": self.closed,
            "path": self.index.path.as_posix(),
        }

    @property
    def connection(
        self,
    ) -> sqlite3.Connection:
        """Return the underlying SQLite connection."""

        self._ensure_open()
        return self.index.connection

    def _initialize_extended_schema(
        self,
    ) -> None:
        """Create richer synonym metadata tables and indexes."""

        self._ensure_writable()

        try:
            self.connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS synonym_assertions(
                    synonym_key TEXT NOT NULL,
                    synonym TEXT NOT NULL,
                    speciedex_id TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    provider_id TEXT NOT NULL,
                    accepted_provider_id TEXT NOT NULL,
                    scientific_name TEXT NOT NULL,
                    canonical_name TEXT NOT NULL,
                    authorship TEXT NOT NULL,
                    rank TEXT NOT NULL,
                    status TEXT NOT NULL,
                    source_url TEXT NOT NULL,
                    source_modified TEXT NOT NULL,
                    metadata_json TEXT NOT NULL,
                    PRIMARY KEY(
                        synonym_key,
                        speciedex_id,
                        provider,
                        provider_id
                    ),
                    FOREIGN KEY(speciedex_id)
                    REFERENCES taxa(speciedex_id)
                    ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS
                synonym_assertions_key
                ON synonym_assertions(
                    synonym_key
                );

                CREATE INDEX IF NOT EXISTS
                synonym_assertions_taxon
                ON synonym_assertions(
                    speciedex_id
                );

                CREATE INDEX IF NOT EXISTS
                synonym_assertions_provider
                ON synonym_assertions(
                    provider
                );

                CREATE INDEX IF NOT EXISTS
                synonym_assertions_provider_id
                ON synonym_assertions(
                    provider,
                    provider_id
                );

                CREATE TABLE IF NOT EXISTS synonym_metadata(
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                """
            )

            self.connection.execute(
                """
                INSERT INTO synonym_metadata(
                    key,
                    value
                )
                VALUES(
                    'schema_version',
                    ?
                )
                ON CONFLICT(key)
                DO UPDATE SET
                    value = excluded.value
                """,
                (
                    str(
                        SYNONYM_SCHEMA_VERSION
                    ),
                ),
            )

            self.connection.commit()

        except sqlite3.Error as error:
            self.connection.rollback()

            raise SynonymIndexError(
                "Unable to initialize synonym "
                f"schema: {error}"
            ) from error

    def replace_for_record(
        self,
        *,
        identifier: str,
        record: Taxon,
        commit: bool = True,
    ) -> int:
        """
        Replace one provider record's synonym assertions.

        Existing synonyms from the same provider and provider identifier are
        removed before the normalized replacement set is inserted.
        """

        self._ensure_writable()

        normalized_identifier = self._required_text(
            identifier,
            "identifier",
        )

        if not normalized_identifier:
            raise ValueError(
                "identifier is required."
            )

        provider = normalize_key(
            record.provider
        )

        provider_id = str(
            record.provider_id
            if record.provider_id is not None
            else ""
        ).strip()

        if not provider:
            raise ValueError(
                "record provider is required."
            )

        if not provider_id:
            raise ValueError(
                "record provider_id is required."
            )

        synonyms = self._record_synonyms(
            record
        )

        assertions = [
            self._build_assertion(
                identifier=normalized_identifier,
                record=record,
                synonym=value,
            )
            for value in synonyms
        ]

        try:
            self.connection.execute(
                """
                DELETE FROM synonym_assertions
                WHERE provider = ?
                  AND provider_id = ?
                """,
                (
                    provider,
                    provider_id,
                ),
            )

            self.connection.execute(
                """
                DELETE FROM synonyms
                WHERE speciedex_id = ?
                  AND provider = ?
                """,
                (
                    normalized_identifier,
                    provider,
                ),
            )

            if assertions:
                self.connection.executemany(
                    """
                    INSERT OR REPLACE INTO
                    synonym_assertions(
                        synonym_key,
                        synonym,
                        speciedex_id,
                        provider,
                        provider_id,
                        accepted_provider_id,
                        scientific_name,
                        canonical_name,
                        authorship,
                        rank,
                        status,
                        source_url,
                        source_modified,
                        metadata_json
                    )
                    VALUES(
                        ?, ?, ?, ?, ?, ?, ?, ?,
                        ?, ?, ?, ?, ?, ?
                    )
                    """,
                    [
                        self._assertion_parameters(
                            assertion
                        )
                        for assertion
                        in assertions
                    ],
                )

                self.connection.executemany(
                    """
                    INSERT OR IGNORE INTO synonyms(
                        synonym_key,
                        speciedex_id,
                        provider
                    )
                    VALUES(
                        ?, ?, ?
                    )
                    """,
                    [
                        (
                            assertion.synonym_key,
                            assertion.speciedex_id,
                            assertion.provider,
                        )
                        for assertion
                        in assertions
                    ],
                )

            if commit:
                self.connection.commit()

        except sqlite3.Error as error:
            if commit:
                self.connection.rollback()

            raise SynonymIndexError(
                "Unable to replace synonym assertions "
                f"for {provider}:{provider_id}: "
                f"{error}"
            ) from error

        return len(
            assertions
        )

    def add(
        self,
        *,
        identifier: str,
        synonym: Any,
        provider: str,
        provider_id: str = "",
        accepted_provider_id: str = "",
        scientific_name: str = "",
        canonical_name_value: str = "",
        authorship: str = "",
        rank: str = "",
        status: str = "",
        source_url: str = "",
        source_modified: str = "",
        metadata: Mapping[str, Any] | None = None,
        commit: bool = True,
    ) -> bool:
        """Add one synonym assertion."""

        self._ensure_writable()

        normalized_identifier = self._required_text(
            identifier,
            "identifier",
        )

        normalized_synonym = (
            normalize_synonym(
                synonym,
                authorship=authorship,
                rank=rank,
            )
        )

        normalized_key = synonym_key(
            normalized_synonym
        )

        if not normalized_key:
            return False

        normalized_provider = (
            normalize_key(provider)
        )

        if not normalized_provider:
            raise ValueError(
                "provider is required."
            )

        assertion = SynonymAssertion(
            synonym=normalized_synonym,
            synonym_key=normalized_key,
            speciedex_id=normalized_identifier,
            provider=normalized_provider,
            provider_id=str(
                provider_id
                if provider_id is not None
                else ""
            ).strip(),
            accepted_provider_id=str(
                accepted_provider_id
                if accepted_provider_id
                is not None
                else ""
            ).strip(),
            scientific_name=(
                normalize_taxon_name(
                    scientific_name
                )
            ),
            canonical_name=(
                normalize_taxon_name(
                    canonical_name_value
                )
            ),
            authorship=(
                normalize_authorship(
                    authorship
                )
            ),
            rank=normalize_rank(
                rank
            ),
            status=normalize_status(
                status
            ),
            source_url=str(
                source_url
                if source_url is not None
                else ""
            ).strip()[:MAX_SOURCE_TEXT_LENGTH],
            source_modified=str(
                source_modified
                if source_modified
                is not None
                else ""
            ).strip()[:MAX_SOURCE_TEXT_LENGTH],
            metadata=self._normalize_metadata(
                metadata
            ),
        )

        try:
            cursor = self.connection.execute(
                """
                INSERT OR IGNORE INTO
                synonym_assertions(
                    synonym_key,
                    synonym,
                    speciedex_id,
                    provider,
                    provider_id,
                    accepted_provider_id,
                    scientific_name,
                    canonical_name,
                    authorship,
                    rank,
                    status,
                    source_url,
                    source_modified,
                    metadata_json
                )
                VALUES(
                    ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?
                )
                """,
                self._assertion_parameters(
                    assertion
                ),
            )

            inserted = (
                cursor.rowcount > 0
            )

            self.connection.execute(
                """
                INSERT OR IGNORE INTO synonyms(
                    synonym_key,
                    speciedex_id,
                    provider
                )
                VALUES(
                    ?, ?, ?
                )
                """,
                (
                    assertion.synonym_key,
                    assertion.speciedex_id,
                    assertion.provider,
                ),
            )

            if commit:
                self.connection.commit()

            return inserted

        except sqlite3.Error as error:
            if commit:
                self.connection.rollback()

            raise SynonymIndexError(
                "Unable to add synonym assertion: "
                f"{error}"
            ) from error

    def remove_provider_record(
        self,
        provider: str,
        provider_id: str,
        *,
        commit: bool = True,
    ) -> int:
        """Remove synonym assertions for one provider record."""

        self._ensure_writable()

        normalized_provider = self._required_key(
            provider,
            "provider",
        )

        normalized_provider_id = str(
            provider_id
            if provider_id is not None
            else ""
        ).strip()

        if not normalized_provider_id:
            raise ValueError(
                "provider_id is required."
            )

        rows = list(
            self.connection.execute(
                """
                SELECT DISTINCT
                    speciedex_id,
                    synonym_key
                FROM synonym_assertions
                WHERE provider = ?
                  AND provider_id = ?
                """,
                (
                    normalized_provider,
                    normalized_provider_id,
                ),
            )
        )

        try:
            cursor = self.connection.execute(
                """
                DELETE FROM synonym_assertions
                WHERE provider = ?
                  AND provider_id = ?
                """,
                (
                    normalized_provider,
                    normalized_provider_id,
                ),
            )

            for row in rows:
                remaining = self.connection.execute(
                    """
                    SELECT 1
                    FROM synonym_assertions
                    WHERE synonym_key = ?
                      AND speciedex_id = ?
                      AND provider = ?
                    LIMIT 1
                    """,
                    (
                        row["synonym_key"],
                        row["speciedex_id"],
                        normalized_provider,
                    ),
                ).fetchone()

                if remaining is None:
                    self.connection.execute(
                        """
                        DELETE FROM synonyms
                        WHERE synonym_key = ?
                          AND speciedex_id = ?
                          AND provider = ?
                        """,
                        (
                            row["synonym_key"],
                            row["speciedex_id"],
                            normalized_provider,
                        ),
                    )

            if commit:
                self.connection.commit()

            return max(
                0,
                int(cursor.rowcount),
            )

        except sqlite3.Error as error:
            if commit:
                self.connection.rollback()

            raise SynonymIndexError(
                "Unable to remove provider synonym "
                f"record: {error}"
            ) from error

    def remove_taxon(
        self,
        identifier: str,
        *,
        commit: bool = True,
    ) -> int:
        """Remove all synonym assertions for one canonical taxon."""

        self._ensure_writable()
        normalized_identifier = self._required_text(
            identifier,
            "identifier",
        )

        try:
            cursor = self.connection.execute(
                """
                DELETE FROM synonym_assertions
                WHERE speciedex_id = ?
                """,
                (
                    normalized_identifier,
                ),
            )

            self.connection.execute(
                """
                DELETE FROM synonyms
                WHERE speciedex_id = ?
                """,
                (
                    normalized_identifier,
                ),
            )

            if commit:
                self.connection.commit()

            return max(
                0,
                int(cursor.rowcount),
            )

        except sqlite3.Error as error:
            if commit:
                self.connection.rollback()

            raise SynonymIndexError(
                "Unable to remove taxon synonyms: "
                f"{error}"
            ) from error

    def lookup(
        self,
        query: Any,
        *,
        authorship: Any = "",
        rank: Any = "",
        kingdom: Any = "",
        family: Any = "",
        genus: Any = "",
        provider: str | None = None,
        limit: int | None = None,
    ) -> SynonymLookup:
        """Resolve one synonym into canonical taxon candidates."""

        self._ensure_open()

        normalized_query = (
            normalize_synonym(
                query,
                authorship=authorship,
                rank=rank,
            )
        )

        query_key = synonym_key(
            normalized_query
        )

        if not query_key:
            return SynonymLookup(
                query=normalized_query,
                query_key="",
                candidates=[],
                exact=True,
                ambiguous=False,
            )

        requested_limit = (
            self.maximum_candidates
            if limit is None
            else self._strict_positive_int(
                limit,
                "limit",
            )
        )

        maximum = min(
            requested_limit,
            self.maximum_candidates,
        )

        clauses = [
            "synonym.synonym_key = ?"
        ]

        parameters: list[Any] = [
            query_key
        ]

        if provider:
            clauses.append(
                "synonym.provider = ?"
            )
            parameters.append(
                normalize_key(provider)
            )

        if kingdom:
            clauses.append(
                "taxon.kingdom = ?"
            )
            parameters.append(
                normalize_key(kingdom)
            )

        if family:
            clauses.append(
                "taxon.family = ?"
            )
            parameters.append(
                normalize_key(family)
            )

        if genus:
            clauses.append(
                "taxon.genus = ?"
            )
            parameters.append(
                normalize_key(genus)
            )

        if rank:
            clauses.append(
                "taxon.rank = ?"
            )
            parameters.append(
                normalize_rank(rank)
            )

        parameters.append(
            maximum
        )

        query_sql = (
            """
            SELECT
                synonym.synonym_key,
                synonym.speciedex_id,
                GROUP_CONCAT(
                    DISTINCT synonym.provider
                ) AS providers,
                COUNT(
                    DISTINCT synonym.provider
                ) AS provider_count,
                taxon.canonical_name,
                taxon.scientific_name,
                taxon.rank,
                taxon.status,
                taxon.kingdom,
                taxon.family,
                taxon.genus
            FROM synonyms AS synonym
            JOIN taxa AS taxon
              ON taxon.speciedex_id =
                 synonym.speciedex_id
            WHERE
            """
            + " AND ".join(
                clauses
            )
            + """
            GROUP BY
                synonym.synonym_key,
                synonym.speciedex_id,
                taxon.canonical_name,
                taxon.scientific_name,
                taxon.rank,
                taxon.status,
                taxon.kingdom,
                taxon.family,
                taxon.genus
            ORDER BY
                provider_count DESC,
                synonym.speciedex_id
            LIMIT ?
            """
        )

        rows = list(
            self.connection.execute(
                query_sql,
                tuple(parameters),
            )
        )

        candidates: list[
            SynonymCandidate
        ] = []

        for row in rows:
            providers = sorted(
                {
                    normalize_key(value)
                    for value in str(
                        row["providers"]
                        or ""
                    ).split(",")
                    if normalize_key(value)
                }
            )

            provider_count = int(
                row["provider_count"]
                or len(providers)
            )

            confidence = (
                self._candidate_confidence(
                    provider_count=provider_count,
                    status=row["status"],
                    rank_match=(
                        not rank
                        or normalize_rank(rank)
                        == normalize_rank(
                            row["rank"]
                        )
                    ),
                    kingdom_match=(
                        not kingdom
                        or normalize_key(
                            kingdom
                        )
                        == normalize_key(
                            row["kingdom"]
                        )
                    ),
                    family_match=(
                        not family
                        or normalize_key(
                            family
                        )
                        == normalize_key(
                            row["family"]
                        )
                    ),
                    genus_match=(
                        not genus
                        or normalize_key(
                            genus
                        )
                        == normalize_key(
                            row["genus"]
                        )
                    ),
                )
            )

            candidates.append(
                SynonymCandidate(
                    speciedex_id=str(
                        row["speciedex_id"]
                    ),
                    synonym=normalized_query,
                    synonym_key=query_key,
                    providers=providers,
                    provider_count=(
                        provider_count
                    ),
                    canonical_name=str(
                        row["canonical_name"]
                        or ""
                    ),
                    scientific_name=str(
                        row["scientific_name"]
                        or ""
                    ),
                    rank=str(
                        row["rank"]
                        or ""
                    ),
                    status=str(
                        row["status"]
                        or ""
                    ),
                    kingdom=str(
                        row["kingdom"]
                        or ""
                    ),
                    family=str(
                        row["family"]
                        or ""
                    ),
                    genus=str(
                        row["genus"]
                        or ""
                    ),
                    confidence=confidence,
                )
            )

        candidates.sort(
            key=lambda candidate: (
                candidate.confidence,
                candidate.provider_count,
                candidate.speciedex_id,
            ),
            reverse=True,
        )

        ambiguous = len(
            {
                candidate.speciedex_id
                for candidate in candidates
            }
        ) > 1

        return SynonymLookup(
            query=normalized_query,
            query_key=query_key,
            candidates=candidates,
            exact=True,
            ambiguous=ambiguous,
        )

    def candidates(
        self,
        synonym: Any,
        *,
        limit: int | None = None,
    ) -> list[str]:
        """Return canonical identifiers for one synonym."""

        self._ensure_open()

        result = self.lookup(
            synonym,
            limit=limit,
        )

        return [
            candidate.speciedex_id
            for candidate
            in result.candidates
        ]

    def assertions_for_synonym(
        self,
        synonym: Any,
    ) -> list[SynonymAssertion]:
        """Return detailed assertions for one synonym."""

        self._ensure_open()

        key = synonym_key(
            synonym
        )

        if not key:
            return []

        rows = self.connection.execute(
            """
            SELECT *
            FROM synonym_assertions
            WHERE synonym_key = ?
            ORDER BY
                provider,
                provider_id,
                speciedex_id
            """,
            (
                key,
            ),
        )

        return [
            self._assertion_from_row(
                row
            )
            for row in rows
        ]

    def assertions_for_taxon(
        self,
        identifier: str,
    ) -> list[SynonymAssertion]:
        """Return detailed synonym assertions for one taxon."""

        self._ensure_open()

        rows = self.connection.execute(
            """
            SELECT *
            FROM synonym_assertions
            WHERE speciedex_id = ?
            ORDER BY
                synonym_key,
                provider,
                provider_id
            """,
            (
                identifier,
            ),
        )

        return [
            self._assertion_from_row(
                row
            )
            for row in rows
        ]

    def synonyms_for_taxon(
        self,
        identifier: str,
        *,
        include_providers: bool = False,
    ) -> list[str] | list[dict[str, Any]]:
        """Return deduplicated synonyms for one taxon."""

        self._ensure_open()

        rows = list(
            self.connection.execute(
                """
                SELECT
                    assertion.synonym_key,
                    MIN(assertion.synonym) AS synonym,
                    GROUP_CONCAT(
                        DISTINCT assertion.provider
                    ) AS providers
                FROM synonym_assertions AS assertion
                WHERE assertion.speciedex_id = ?
                GROUP BY assertion.synonym_key
                ORDER BY assertion.synonym_key
                """,
                (
                    identifier,
                ),
            )
        )

        if include_providers:
            return [
                {
                    "synonym": str(
                        row["synonym"]
                        or ""
                    ),
                    "synonym_key": str(
                        row["synonym_key"]
                        or ""
                    ),
                    "providers": sorted(
                        {
                            normalize_key(value)
                            for value
                            in str(
                                row["providers"]
                                or ""
                            ).split(",")
                            if normalize_key(
                                value
                            )
                        }
                    ),
                }
                for row in rows
            ]

        return [
            str(
                row["synonym"]
                or ""
            )
            for row in rows
            if str(
                row["synonym"]
                or ""
            )
        ]

    def ambiguous_synonyms(
        self,
        *,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        """Return synonyms mapped to multiple canonical taxa."""

        self._ensure_open()

        maximum = (
            self.maximum_candidates
            if limit is None
            else self._strict_positive_int(
                limit,
                "limit",
            )
        )

        rows = self.connection.execute(
            """
            SELECT
                synonym_key,
                COUNT(
                    DISTINCT speciedex_id
                ) AS taxon_count,
                GROUP_CONCAT(
                    DISTINCT speciedex_id
                ) AS taxa
            FROM synonyms
            GROUP BY synonym_key
            HAVING COUNT(
                DISTINCT speciedex_id
            ) > 1
            ORDER BY
                taxon_count DESC,
                synonym_key
            LIMIT ?
            """,
            (
                maximum,
            ),
        )

        return [
            {
                "synonym_key": str(
                    row["synonym_key"]
                ),
                "taxon_count": int(
                    row["taxon_count"]
                ),
                "speciedex_ids": sorted(
                    {
                        value
                        for value
                        in str(
                            row["taxa"]
                            or ""
                        ).split(",")
                        if value
                    }
                ),
            }
            for row in rows
        ]

    def statistics(
        self,
    ) -> SynonymStatistics:
        """Return aggregate synonym statistics."""

        self._ensure_open()

        row = self.connection.execute(
            """
            SELECT
                COUNT(*) AS rows,
                COUNT(
                    DISTINCT synonym_key
                ) AS unique_synonyms,
                COUNT(
                    DISTINCT speciedex_id
                ) AS canonical_taxa,
                COUNT(
                    DISTINCT provider
                ) AS providers
            FROM synonyms
            """
        ).fetchone()

        ambiguous_row = self.connection.execute(
            """
            SELECT COUNT(*) AS count
            FROM(
                SELECT synonym_key
                FROM synonyms
                GROUP BY synonym_key
                HAVING COUNT(
                    DISTINCT speciedex_id
                ) > 1
            )
            """
        ).fetchone()

        provider_counts = {
            str(
                item["provider"]
            ): int(
                item["count"]
            )
            for item
            in self.connection.execute(
                """
                SELECT
                    provider,
                    COUNT(*) AS count
                FROM synonyms
                GROUP BY provider
                ORDER BY
                    count DESC,
                    provider
                """
            )
        }

        rank_counts = {
            str(
                item["rank"]
                or "unranked"
            ): int(
                item["count"]
            )
            for item
            in self.connection.execute(
                """
                SELECT
                    taxon.rank AS rank,
                    COUNT(*) AS count
                FROM synonyms AS synonym
                JOIN taxa AS taxon
                  ON taxon.speciedex_id =
                     synonym.speciedex_id
                GROUP BY taxon.rank
                ORDER BY
                    count DESC,
                    taxon.rank
                """
            )
        }

        return SynonymStatistics(
            rows=int(
                row["rows"]
                if row
                else 0
            ),
            unique_synonyms=int(
                row["unique_synonyms"]
                if row
                else 0
            ),
            canonical_taxa=int(
                row["canonical_taxa"]
                if row
                else 0
            ),
            providers=int(
                row["providers"]
                if row
                else 0
            ),
            ambiguous_synonyms=int(
                ambiguous_row["count"]
                if ambiguous_row
                else 0
            ),
            provider_counts=(
                provider_counts
            ),
            rank_counts=rank_counts,
        )

    def verify(
        self,
    ) -> SynonymVerification:
        """Verify synonym-index consistency."""

        self._ensure_open()

        errors: list[str] = []
        warnings: list[str] = []

        rows = self.index.table_count(
            "synonyms"
        )

        orphaned_rows = int(
            self.connection.execute(
                """
                SELECT COUNT(*) AS count
                FROM synonyms AS synonym
                LEFT JOIN taxa AS taxon
                  ON taxon.speciedex_id =
                     synonym.speciedex_id
                WHERE taxon.speciedex_id IS NULL
                """
            ).fetchone()["count"]
        )

        if orphaned_rows:
            errors.append(
                "Orphaned synonym rows: "
                f"{orphaned_rows}."
            )

        empty_keys = int(
            self.connection.execute(
                """
                SELECT COUNT(*) AS count
                FROM synonyms
                WHERE synonym_key = ''
                   OR provider = ''
                   OR speciedex_id = ''
                """
            ).fetchone()["count"]
        )

        if empty_keys:
            errors.append(
                "Synonym rows with empty required "
                f"fields: {empty_keys}."
            )

        duplicate_rows = int(
            self.connection.execute(
                """
                SELECT COUNT(*) AS count
                FROM(
                    SELECT
                        synonym_key,
                        speciedex_id,
                        provider,
                        COUNT(*) AS duplicates
                    FROM synonyms
                    GROUP BY
                        synonym_key,
                        speciedex_id,
                        provider
                    HAVING COUNT(*) > 1
                )
                """
            ).fetchone()["count"]
        )

        if duplicate_rows:
            errors.append(
                "Duplicate synonym-key mappings: "
                f"{duplicate_rows}."
            )

        assertion_orphans = int(
            self.connection.execute(
                """
                SELECT COUNT(*) AS count
                FROM synonym_assertions AS assertion
                LEFT JOIN taxa AS taxon
                  ON taxon.speciedex_id =
                     assertion.speciedex_id
                WHERE taxon.speciedex_id IS NULL
                """
            ).fetchone()["count"]
        )

        if assertion_orphans:
            errors.append(
                "Orphaned detailed synonym "
                f"assertions: {assertion_orphans}."
            )

        unmatched_base_rows = int(
            self.connection.execute(
                """
                SELECT COUNT(*) AS count
                FROM synonyms AS synonym
                LEFT JOIN synonym_assertions AS assertion
                  ON assertion.synonym_key =
                     synonym.synonym_key
                 AND assertion.speciedex_id =
                     synonym.speciedex_id
                 AND assertion.provider =
                     synonym.provider
                WHERE assertion.synonym_key IS NULL
                """
            ).fetchone()["count"]
        )

        if unmatched_base_rows:
            warnings.append(
                "Base synonym rows without detailed "
                f"assertions: {unmatched_base_rows}."
            )

        invalid_normalization = 0

        for row in self.connection.execute(
            """
            SELECT
                synonym_key,
                synonym
            FROM synonym_assertions
            """
        ):
            expected = synonym_key(
                row["synonym"]
            )

            if expected != str(
                row["synonym_key"]
            ):
                invalid_normalization += 1

        if invalid_normalization:
            errors.append(
                "Detailed synonym assertions with "
                "incorrect normalized keys: "
                f"{invalid_normalization}."
            )

        schema_row = self.connection.execute(
            """
            SELECT value
            FROM synonym_metadata
            WHERE key = 'schema_version'
            """
        ).fetchone()

        if (
            schema_row is None
            or str(
                schema_row["value"]
            )
            != str(
                SYNONYM_SCHEMA_VERSION
            )
        ):
            errors.append(
                "Synonym schema version mismatch."
            )

        return SynonymVerification(
            valid=not errors,
            errors=errors,
            warnings=warnings,
            rows=rows,
            orphaned_rows=orphaned_rows,
            empty_keys=empty_keys,
            duplicate_rows=duplicate_rows,
            assertion_orphans=assertion_orphans,
            unmatched_base_rows=unmatched_base_rows,
            invalid_normalization=invalid_normalization,
        )

    def rebuild_from_assertions(
        self,
        records: Iterable[
            tuple[str, Taxon]
        ],
        *,
        clear_existing: bool = True,
    ) -> int:
        """
        Rebuild the synonym index from canonical identifier/Taxon pairs.
        """

        self._ensure_writable()
        inserted = 0

        with self.index.transaction():
            if clear_existing:
                self.connection.execute(
                    "DELETE FROM synonym_assertions"
                )

                self.connection.execute(
                    "DELETE FROM synonyms"
                )

            for identifier, record in records:
                inserted += self.replace_for_record(
                    identifier=identifier,
                    record=record,
                    commit=False,
                )

        return inserted

    def rebuild_base_table(
        self,
        *,
        clear_existing: bool = True,
    ) -> int:
        """
        Rebuild the compatibility ``synonyms`` table from detailed assertions.
        """

        self._ensure_writable()

        try:
            with self.index.transaction():
                if clear_existing:
                    self.connection.execute(
                        "DELETE FROM synonyms"
                    )

                cursor = self.connection.execute(
                    """
                    INSERT OR IGNORE INTO synonyms(
                        synonym_key,
                        speciedex_id,
                        provider
                    )
                    SELECT DISTINCT
                        synonym_key,
                        speciedex_id,
                        provider
                    FROM synonym_assertions
                    """
                )

            return max(
                0,
                int(cursor.rowcount),
            )

        except sqlite3.Error as error:
            raise SynonymIndexError(
                "Unable to rebuild base synonym "
                f"table: {error}"
            ) from error

    def iter_assertions(
        self,
    ) -> Iterator[SynonymAssertion]:
        """Iterate every detailed synonym assertion."""

        self._ensure_open()

        rows = self.connection.execute(
            """
            SELECT *
            FROM synonym_assertions
            ORDER BY
                synonym_key,
                speciedex_id,
                provider,
                provider_id
            """
        )

        for row in rows:
            yield self._assertion_from_row(
                row
            )

    def clear(
        self,
        *,
        commit: bool = True,
    ) -> None:
        """Clear all rebuildable synonym data."""

        self._ensure_writable()

        try:
            self.connection.execute(
                "DELETE FROM synonym_assertions"
            )

            self.connection.execute(
                "DELETE FROM synonyms"
            )

            if commit:
                self.connection.commit()

        except sqlite3.Error as error:
            if commit:
                self.connection.rollback()

            raise SynonymIndexError(
                "Unable to clear synonym index: "
                f"{error}"
            ) from error

    @staticmethod
    def _required_text(
        value: Any,
        field_name: str,
    ) -> str:
        """Return required normalized text."""

        normalized = " ".join(
            str(
                value
                if value is not None
                else ""
            ).strip().split()
        )

        if not normalized:
            raise ValueError(
                f"{field_name} is required."
            )

        return normalized

    @staticmethod
    def _required_key(
        value: Any,
        field_name: str,
    ) -> str:
        """Return a required normalized lookup key."""

        normalized = normalize_key(
            value
        )

        if not normalized:
            raise ValueError(
                f"{field_name} is required."
            )

        return normalized

    @staticmethod
    def _strict_positive_int(
        value: Any,
        field_name: str,
    ) -> int:
        """Parse a strictly positive integer without truncating fractions."""

        if isinstance(
            value,
            bool,
        ):
            raise ValueError(
                f"{field_name} must be a positive integer."
            )

        if isinstance(
            value,
            int,
        ):
            parsed = value
        elif isinstance(
            value,
            float,
        ):
            if (
                not math.isfinite(
                    value
                )
                or not value.is_integer()
            ):
                raise ValueError(
                    f"{field_name} must be a positive integer."
                )
            parsed = int(
                value
            )
        else:
            text = str(
                value
                if value is not None
                else ""
            ).strip()

            if not re.fullmatch(
                r"[0-9]+",
                text,
            ):
                raise ValueError(
                    f"{field_name} must be a positive integer."
                )
            parsed = int(
                text
            )

        if parsed <= 0:
            raise ValueError(
                f"{field_name} must be positive."
            )

        return parsed

    @staticmethod
    def _normalize_metadata(
        metadata: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        """Validate and normalize assertion metadata."""

        if metadata is None:
            return {}

        if not isinstance(
            metadata,
            Mapping,
        ):
            raise TypeError(
                "metadata must be a mapping."
            )

        normalized = dict(
            metadata
        )
        SynonymIndex._metadata_json(
            normalized
        )
        return normalized

    @staticmethod
    def _metadata_json(
        metadata: Mapping[str, Any],
    ) -> str:
        """Serialize metadata deterministically and enforce a size limit."""

        try:
            payload = json.dumps(
                dict(
                    metadata
                ),
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
                allow_nan=False,
            )
        except (
            TypeError,
            ValueError,
        ) as error:
            raise ValueError(
                "metadata must be JSON serializable."
            ) from error

        if len(
            payload.encode(
                "utf-8"
            )
        ) > MAX_METADATA_JSON_BYTES:
            raise ValueError(
                "metadata JSON exceeds the size limit."
            )

        return payload

    def _record_synonyms(
        self,
        record: Taxon,
    ) -> list[str]:
        """Build the normalized synonym set for one Taxon."""

        values: list[Any] = list(
            record.synonyms
        )

        normalized_status = (
            normalize_status(
                record.status
            )
        )

        if (
            normalized_status
            in SYNONYM_LIKE_STATUSES
            and record.scientific_name
        ):
            values.append(
                record.scientific_name
            )

        normalized = normalize_synonyms(
            values,
            scientific_name=(
                record.scientific_name
                if normalized_status
                in ACCEPTED_LIKE_STATUSES
                else ""
            ),
            canonical=(
                record.canonical_name
                if normalized_status
                in ACCEPTED_LIKE_STATUSES
                else ""
            ),
        )

        result: list[str] = []
        seen: set[str] = set()

        for value in normalized:
            prepared = normalize_synonym(
                value,
                rank=record.rank,
            )

            key = synonym_key(
                prepared
            )

            if not key or key in seen:
                continue

            seen.add(key)
            result.append(
                prepared
            )

        return result

    def _build_assertion(
        self,
        *,
        identifier: str,
        record: Taxon,
        synonym: str,
    ) -> SynonymAssertion:
        """Build one detailed assertion from a provider Taxon."""

        normalized = normalize_synonym(
            synonym,
            rank=record.rank,
        )

        key = synonym_key(
            normalized
        )

        return SynonymAssertion(
            synonym=normalized,
            synonym_key=key,
            speciedex_id=identifier,
            provider=normalize_key(
                record.provider
            ),
            provider_id=str(
                record.provider_id
            ),
            accepted_provider_id=str(
                record.accepted_provider_id
                or ""
            ),
            scientific_name=(
                normalize_taxon_name(
                    record.scientific_name
                )
            ),
            canonical_name=(
                normalize_taxon_name(
                    record.canonical_name
                )
            ),
            authorship=(
                normalize_authorship(
                    record.authorship
                )
            ),
            rank=normalize_rank(
                record.rank
            ),
            status=normalize_status(
                record.status
            ),
            source_url=str(
                record.source_url
                or ""
            ).strip()[:MAX_SOURCE_TEXT_LENGTH],
            source_modified=str(
                record.source_modified
                or ""
            ).strip()[:MAX_SOURCE_TEXT_LENGTH],
            metadata=self._normalize_metadata(
                {
                    "retrieved_at": (
                        record.retrieved_at
                    ),
                }
            ),
        )

    @staticmethod
    def _assertion_parameters(
        assertion: SynonymAssertion,
    ) -> tuple[Any, ...]:
        """Return SQL parameters for one assertion."""

        return (
            assertion.synonym_key,
            assertion.synonym,
            assertion.speciedex_id,
            assertion.provider,
            assertion.provider_id,
            assertion.accepted_provider_id,
            assertion.scientific_name,
            assertion.canonical_name,
            assertion.authorship,
            assertion.rank,
            assertion.status,
            assertion.source_url,
            assertion.source_modified,
            SynonymIndex._metadata_json(
                assertion.metadata
            ),
        )

    @staticmethod
    def _assertion_from_row(
        row: sqlite3.Row,
    ) -> SynonymAssertion:
        """Convert a SQLite row into SynonymAssertion."""

        metadata_value = row[
            "metadata_json"
        ]

        try:
            metadata = json.loads(
                metadata_value
            )
        except (
            TypeError,
            json.JSONDecodeError,
        ):
            metadata = {}

        if not isinstance(
            metadata,
            dict,
        ):
            metadata = {}

        return SynonymAssertion(
            synonym=str(
                row["synonym"]
            ),
            synonym_key=str(
                row["synonym_key"]
            ),
            speciedex_id=str(
                row["speciedex_id"]
            ),
            provider=str(
                row["provider"]
            ),
            provider_id=str(
                row["provider_id"]
            ),
            accepted_provider_id=str(
                row["accepted_provider_id"]
            ),
            scientific_name=str(
                row["scientific_name"]
            ),
            canonical_name=str(
                row["canonical_name"]
            ),
            authorship=str(
                row["authorship"]
            ),
            rank=str(
                row["rank"]
            ),
            status=str(
                row["status"]
            ),
            source_url=str(
                row["source_url"]
            ),
            source_modified=str(
                row["source_modified"]
            ),
            metadata=metadata,
        )

    @staticmethod
    def _candidate_confidence(
        *,
        provider_count: int,
        status: Any,
        rank_match: bool,
        kingdom_match: bool,
        family_match: bool,
        genus_match: bool,
    ) -> float:
        """Calculate a normalized synonym candidate confidence."""

        score = 0.0
        maximum = 0.0

        provider_score = min(
            max(
                provider_count,
                0,
            ),
            5,
        ) / 5.0

        score += provider_score * 0.35
        maximum += 0.35

        normalized_status = (
            normalize_status(
                status
            )
        )

        if normalized_status in (
            ACCEPTED_LIKE_STATUSES
        ):
            score += 0.25

        elif normalized_status in (
            SYNONYM_LIKE_STATUSES
        ):
            score += 0.10

        maximum += 0.25

        for matched, weight in (
            (
                rank_match,
                0.10,
            ),
            (
                kingdom_match,
                0.10,
            ),
            (
                family_match,
                0.10,
            ),
            (
                genus_match,
                0.10,
            ),
        ):
            maximum += weight

            if matched:
                score += weight

        if maximum <= 0:
            return 0.0

        return max(
            0.0,
            min(
                1.0,
                score / maximum,
            ),
        )

__all__ = [
    "ACCEPTED_LIKE_STATUSES",
    "DEFAULT_MAX_CANDIDATES",
    "MAX_METADATA_JSON_BYTES",
    "MAX_SOURCE_TEXT_LENGTH",
    "SYNONYM_LIKE_STATUSES",
    "SYNONYM_SCHEMA_VERSION",
    "SynonymAssertion",
    "SynonymCandidate",
    "SynonymIndex",
    "SynonymIndexError",
    "SynonymLookup",
    "SynonymStatistics",
    "SynonymVerification",
    "normalize_synonym",
    "synonym_key",
]
