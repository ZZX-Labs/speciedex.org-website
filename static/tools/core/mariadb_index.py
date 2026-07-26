#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/mariadb_index.py

MariaDB-backed canonical taxonomic index.

This module implements the same public index contract as sqlite_index.py.
The JSONL archive remains the durable append-only record store. MariaDB is a
rebuildable server-side lookup and reconciliation index.

The optional ``mariadb`` Python package is imported only when this backend is
constructed, so SQLite-only installations do not require MariaDB libraries.

Copyright (c) 2026 ZZX-Laboratories
Licensed under the MIT License.
"""

from __future__ import annotations

import json
import re
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator, Mapping, Sequence

from providers.common import Taxon

from .archive import normalize_key, normalize_space, now


MARIADB_SCHEMA_VERSION = 1

DEFAULT_CONNECT_TIMEOUT_SECONDS = 30.0
MIN_PORT = 1
MAX_PORT = 65535

_SQL_IDENTIFIER_PATTERN = re.compile(
    r"^[A-Za-z_][A-Za-z0-9_]*$"
)

_INDEX_TABLES = (
    "taxa",
    "source_ids",
    "assertions",
    "synonyms",
    "conflicts",
    "archive_metadata",
)

_MUTABLE_TABLES = (
    "synonyms",
    "assertions",
    "source_ids",
    "conflicts",
    "taxa",
)


class MariaDBIndexError(RuntimeError):
    """Raised when the MariaDB index cannot complete an operation."""


@dataclass(slots=True)
class MariaDBVerification:
    """Structured MariaDB verification result."""

    valid: bool
    errors: list[str] = field(
        default_factory=list
    )
    warnings: list[str] = field(
        default_factory=list
    )
    table_counts: dict[str, int] = field(
        default_factory=dict
    )
    orphan_counts: dict[str, int] = field(
        default_factory=dict
    )

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
            "table_counts": dict(
                self.table_counts
            ),
            "orphan_counts": dict(
                self.orphan_counts
            ),
        }


def validate_sql_identifier(
    value: Any,
    *,
    label: str = "identifier",
) -> str:
    """Validate a MariaDB SQL identifier used in generated DDL."""

    normalized = normalize_space(
        value
    )

    if not normalized:
        raise MariaDBIndexError(
            f"{label} cannot be empty."
        )

    if not _SQL_IDENTIFIER_PATTERN.fullmatch(
        normalized
    ):
        raise MariaDBIndexError(
            f"Unsafe {label}: {normalized!r}."
        )

    return normalized


class MariaDBIndex:
    """
    Rebuildable MariaDB index for the Speciedex archive.

    Public methods intentionally mirror SQLiteIndex so DatabaseManager can
    switch backends without requiring changes to Archive or provider code.
    """

    def __init__(
        self,
        *,
        database: str,
        host: str = "127.0.0.1",
        port: int = 3306,
        user: str | None = None,
        password: str | None = None,
        unix_socket: str | None = None,
        connect_timeout: float = DEFAULT_CONNECT_TIMEOUT_SECONDS,
        read_only: bool = False,
        autocommit: bool = False,
        charset: str = "utf8mb4",
        collation: str = "utf8mb4_unicode_ci",
        ssl: bool | Mapping[str, Any] | None = None,
        **connector_options: Any,
    ) -> None:
        self.database_name = normalize_space(database)
        self.host = normalize_space(host) or "127.0.0.1"
        self.port = int(port)
        self.user = user
        self.password = password
        self.unix_socket = unix_socket
        self.connect_timeout = float(connect_timeout)
        self.read_only = bool(read_only)
        self.autocommit = bool(autocommit)
        self.charset = normalize_space(charset) or "utf8mb4"
        self.collation = normalize_space(collation) or "utf8mb4_unicode_ci"
        self.ssl = ssl
        self.connector_options = dict(connector_options)

        self._closed = False
        self._transaction_depth = 0
        self._validate_configuration()

        self._driver = self._load_driver()
        self.connection = self._connect()

        if not self.read_only:
            self._initialize_schema()

    def _validate_configuration(self) -> None:
        """Validate connection and schema configuration."""

        if not self.database_name:
            raise MariaDBIndexError(
                "MariaDB database name cannot be empty."
            )

        if not (
            MIN_PORT
            <= self.port
            <= MAX_PORT
        ):
            raise MariaDBIndexError(
                "MariaDB port must be between "
                f"{MIN_PORT} and {MAX_PORT}."
            )

        if self.connect_timeout <= 0:
            raise MariaDBIndexError(
                "connect_timeout must be positive."
            )

        self.charset = validate_sql_identifier(
            self.charset,
            label="charset",
        )
        self.collation = validate_sql_identifier(
            self.collation,
            label="collation",
        )

    def _ensure_open(self) -> None:
        """Raise when an operation is attempted after close."""

        if self._closed:
            raise MariaDBIndexError(
                "MariaDB index is closed."
            )

    def _ensure_writable(self) -> None:
        """Raise when a write is attempted on a read-only index."""

        self._ensure_open()

        if self.read_only:
            raise MariaDBIndexError(
                "MariaDB index is read-only."
            )

    @property
    def closed(self) -> bool:
        """Return whether the connection is closed."""

        return self._closed

    @property
    def transaction_depth(self) -> int:
        """Return current nested transaction depth."""

        return self._transaction_depth

    def __enter__(self) -> "MariaDBIndex":
        self._ensure_open()
        return self

    def __exit__(
        self,
        exc_type: Any,
        exc_value: Any,
        traceback: Any,
    ) -> None:
        self.close()

    @staticmethod
    def _load_driver() -> Any:
        """Import MariaDB Connector/Python on demand."""

        try:
            import mariadb  # type: ignore
        except ImportError as error:
            raise MariaDBIndexError(
                "MariaDB backend requires MariaDB Connector/Python. "
                "Install it with: python -m pip install mariadb"
            ) from error

        return mariadb

    def _connect(self) -> Any:
        """Create the MariaDB connection."""

        if not self.database_name:
            raise MariaDBIndexError(
                "MariaDB database name cannot be empty."
            )

        options: dict[str, Any] = {
            "database": self.database_name,
            "connect_timeout": self.connect_timeout,
            "autocommit": self.autocommit,
        }

        if self.unix_socket:
            options["unix_socket"] = self.unix_socket
        else:
            options["host"] = self.host
            options["port"] = self.port

        if self.user is not None:
            options["user"] = self.user

        if self.password is not None:
            options["password"] = self.password

        if self.ssl:
            if isinstance(self.ssl, Mapping):
                options.update(dict(self.ssl))
            else:
                options["ssl"] = True

        options.update(self.connector_options)

        try:
            connection = self._driver.connect(**options)
            connection.autocommit = self.autocommit
            return connection
        except self._driver.Error as error:
            raise MariaDBIndexError(
                f"Unable to open MariaDB index "
                f"{self.host}:{self.port}/{self.database_name}: {error}"
            ) from error

    @property
    def database(self) -> Any:
        """Compatibility alias for code expecting archive.database."""

        return self.connection

    def _cursor(self, *, dictionary: bool = True) -> Any:
        self._ensure_open()

        try:
            return self.connection.cursor(
                dictionary=dictionary
            )
        except self._driver.Error as error:
            raise MariaDBIndexError(
                f"Unable to create MariaDB cursor: {error}"
            ) from error

    def _execute(
        self,
        query: str,
        parameters: Sequence[Any] = (),
        *,
        dictionary: bool = True,
    ) -> Any:
        cursor = self._cursor(
            dictionary=dictionary
        )

        try:
            cursor.execute(
                query,
                tuple(
                    parameters
                ),
            )
            return cursor
        except self._driver.Error as error:
            try:
                cursor.close()
            except Exception:
                pass

            raise MariaDBIndexError(
                f"MariaDB query failed: {error}"
            ) from error

    def _executemany(
        self,
        query: str,
        parameter_rows: Iterable[Sequence[Any]],
    ) -> Any:
        cursor = self._cursor(
            dictionary=False
        )

        rows = [
            tuple(
                row
            )
            for row in parameter_rows
        ]

        try:
            cursor.executemany(
                query,
                rows,
            )
            return cursor
        except self._driver.Error as error:
            try:
                cursor.close()
            except Exception:
                pass

            raise MariaDBIndexError(
                f"MariaDB batch query failed: {error}"
            ) from error

    def _initialize_schema(self) -> None:
        """Create all MariaDB tables and indexes."""

        statements = [
            f"""
            CREATE TABLE IF NOT EXISTS archive_metadata(
                `key` VARCHAR(191) NOT NULL,
                `value` LONGTEXT NOT NULL,
                PRIMARY KEY(`key`)
            ) ENGINE=InnoDB
              DEFAULT CHARSET={self.charset}
              COLLATE={self.collation}
            """,
            f"""
            CREATE TABLE IF NOT EXISTS taxa(
                speciedex_id VARCHAR(128) NOT NULL,
                identity_key VARCHAR(128) NOT NULL,
                scientific_name VARCHAR(512) NOT NULL,
                canonical_name VARCHAR(512) NOT NULL,
                rank VARCHAR(64) NOT NULL,
                status VARCHAR(64) NOT NULL,
                authorship VARCHAR(512) NOT NULL,
                kingdom VARCHAR(191) NOT NULL,
                phylum VARCHAR(191) NOT NULL,
                class_name VARCHAR(191) NOT NULL,
                order_name VARCHAR(191) NOT NULL,
                family VARCHAR(191) NOT NULL,
                genus VARCHAR(191) NOT NULL,
                record_json LONGTEXT NOT NULL,
                record_hash VARCHAR(128) NOT NULL,
                volume_file VARCHAR(512) NOT NULL,
                line_number BIGINT UNSIGNED NOT NULL,
                created_at VARCHAR(40) NOT NULL,
                updated_at VARCHAR(40) NOT NULL,
                PRIMARY KEY(speciedex_id),
                KEY taxa_identity(identity_key),
                KEY taxa_name(canonical_name, rank, kingdom),
                KEY taxa_scientific_name(scientific_name),
                KEY taxa_rank(rank),
                KEY taxa_status(status),
                KEY taxa_kingdom(kingdom),
                KEY taxa_family(family),
                KEY taxa_genus(genus),
                KEY taxa_volume(volume_file(191), line_number)
            ) ENGINE=InnoDB
              DEFAULT CHARSET={self.charset}
              COLLATE={self.collation}
            """,
            f"""
            CREATE TABLE IF NOT EXISTS source_ids(
                provider VARCHAR(128) NOT NULL,
                provider_id VARCHAR(512) NOT NULL,
                speciedex_id VARCHAR(128) NOT NULL,
                PRIMARY KEY(provider, provider_id),
                KEY source_ids_taxon(speciedex_id),
                KEY source_ids_provider(provider)
            ) ENGINE=InnoDB
              DEFAULT CHARSET={self.charset}
              COLLATE={self.collation}
            """,
            f"""
            CREATE TABLE IF NOT EXISTS assertions(
                provider VARCHAR(128) NOT NULL,
                provider_id VARCHAR(512) NOT NULL,
                speciedex_id VARCHAR(128) NOT NULL,
                assertion_json LONGTEXT NOT NULL,
                assertion_hash VARCHAR(128) NOT NULL,
                updated_at VARCHAR(40) NOT NULL,
                PRIMARY KEY(provider, provider_id),
                KEY assertions_taxon(speciedex_id),
                KEY assertions_provider(provider),
                KEY assertions_updated(updated_at)
            ) ENGINE=InnoDB
              DEFAULT CHARSET={self.charset}
              COLLATE={self.collation}
            """,
            f"""
            CREATE TABLE IF NOT EXISTS synonyms(
                synonym_key VARCHAR(512) NOT NULL,
                speciedex_id VARCHAR(128) NOT NULL,
                provider VARCHAR(128) NOT NULL,
                PRIMARY KEY(synonym_key, speciedex_id, provider),
                KEY synonyms_name(synonym_key),
                KEY synonyms_taxon(speciedex_id),
                KEY synonyms_provider(provider)
            ) ENGINE=InnoDB
              DEFAULT CHARSET={self.charset}
              COLLATE={self.collation}
            """,
            f"""
            CREATE TABLE IF NOT EXISTS conflicts(
                conflict_id VARCHAR(191) NOT NULL,
                conflict_json LONGTEXT NOT NULL,
                created_at VARCHAR(40) NOT NULL,
                PRIMARY KEY(conflict_id),
                KEY conflicts_created(created_at)
            ) ENGINE=InnoDB
              DEFAULT CHARSET={self.charset}
              COLLATE={self.collation}
            """,
        ]

        try:
            cursor = self._cursor(dictionary=False)
            for statement in statements:
                cursor.execute(statement)

            self.set_metadata(
                "schema_version",
                str(MARIADB_SCHEMA_VERSION),
                commit=False,
            )
            self.connection.commit()
        except self._driver.Error as error:
            self.connection.rollback()
            raise MariaDBIndexError(
                f"Unable to initialize MariaDB schema: {error}"
            ) from error

    @contextmanager
    def transaction(self) -> Iterator[Any]:
        """Run a transaction; nested calls reuse the outer transaction."""

        self._ensure_writable()

        outermost = (
            self._transaction_depth == 0
        )

        if outermost:
            try:
                self.connection.begin()
            except self._driver.Error as error:
                raise MariaDBIndexError(
                    f"Unable to begin MariaDB transaction: {error}"
                ) from error

        self._transaction_depth += 1

        try:
            yield self.connection

        except BaseException:
            self._transaction_depth = max(
                0,
                self._transaction_depth - 1,
            )

            if outermost:
                try:
                    self.connection.rollback()
                except self._driver.Error as rollback_error:
                    raise MariaDBIndexError(
                        "MariaDB transaction failed and rollback "
                        f"also failed: {rollback_error}"
                    ) from rollback_error

            raise

        else:
            self._transaction_depth = max(
                0,
                self._transaction_depth - 1,
            )

            if outermost:
                try:
                    self.connection.commit()
                except self._driver.Error as error:
                    try:
                        self.connection.rollback()
                    except self._driver.Error:
                        pass

                    raise MariaDBIndexError(
                        f"Unable to commit MariaDB transaction: {error}"
                    ) from error

    def commit(self) -> None:
        self._ensure_writable()

        try:
            self.connection.commit()
        except self._driver.Error as error:
            raise MariaDBIndexError(
                f"Unable to commit MariaDB transaction: {error}"
            ) from error

    def rollback(self) -> None:
        self._ensure_writable()

        try:
            self.connection.rollback()
        except self._driver.Error as error:
            raise MariaDBIndexError(
                f"Unable to roll back MariaDB transaction: {error}"
            ) from error

    def checkpoint(self, *, truncate: bool = False) -> None:
        """Compatibility no-op; MariaDB does not use a SQLite WAL."""

        _ = truncate

    def close(
        self,
        *,
        commit: bool = True,
    ) -> None:
        """Close the MariaDB connection safely."""

        if self._closed:
            return

        try:
            if not self.read_only:
                if (
                    commit
                    and self._transaction_depth == 0
                ):
                    self.connection.commit()
                else:
                    self.connection.rollback()
        finally:
            try:
                self.connection.close()
            finally:
                self._transaction_depth = 0
                self._closed = True

    def set_metadata(
        self,
        key: str,
        value: Any,
        *,
        commit: bool = True,
    ) -> None:
        self._ensure_writable()

        normalized_key = normalize_space(key)

        if not normalized_key:
            raise ValueError("Metadata key cannot be empty.")

        try:
            self._execute(
                """
                INSERT INTO archive_metadata(`key`, `value`)
                VALUES(?, ?)
                ON DUPLICATE KEY UPDATE
                    `value` = VALUES(`value`)
                """,
                (normalized_key, str(value)),
                dictionary=False,
            )

            if commit:
                self.connection.commit()
        except self._driver.Error as error:
            if commit:
                self.connection.rollback()
            raise MariaDBIndexError(
                f"Unable to set MariaDB metadata {normalized_key!r}: {error}"
            ) from error

    def metadata(self, key: str, default: Any = None) -> Any:
        cursor = self._execute(
            """
            SELECT `value`
            FROM archive_metadata
            WHERE `key` = ?
            """,
            (normalize_space(key),),
        )
        row = cursor.fetchone()
        return default if row is None else row["value"]

    def insert_taxon(
        self,
        *,
        identifier: str,
        identity_key: str,
        record: Taxon,
        primary_json: str,
        record_hash: str,
        volume_file: str,
        line_number: int,
        created_at: str,
        updated_at: str | None = None,
        commit: bool = True,
    ) -> None:
        self._ensure_writable()

        normalized_identifier = normalize_space(
            identifier
        )
        normalized_identity_key = normalize_space(
            identity_key
        )

        if not normalized_identifier:
            raise ValueError(
                "identifier cannot be empty."
            )

        if not normalized_identity_key:
            raise ValueError(
                "identity_key cannot be empty."
            )

        if int(
            line_number
        ) < 0:
            raise ValueError(
                "line_number cannot be negative."
            )

        timestamp = updated_at or created_at or now()

        try:
            self._execute(
                """
                INSERT INTO taxa(
                    speciedex_id, identity_key, scientific_name,
                    canonical_name, rank, status, authorship, kingdom,
                    phylum, class_name, order_name, family, genus,
                    record_json, record_hash, volume_file, line_number,
                    created_at, updated_at
                )
                VALUES(
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
                """,
                (
                    normalized_identifier,
                    normalized_identity_key,
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
                    record_hash,
                    volume_file,
                    int(line_number),
                    created_at,
                    timestamp,
                ),
                dictionary=False,
            )

            if commit:
                self.connection.commit()
        except self._driver.Error as error:
            if commit:
                self.connection.rollback()
            raise MariaDBIndexError(
                f"Unable to insert canonical taxon {identifier}: {error}"
            ) from error

    def update_taxon_timestamp(
        self,
        identifier: str,
        timestamp: str | None = None,
        *,
        commit: bool = True,
    ) -> None:
        self._ensure_writable()

        self._execute(
            """
            UPDATE taxa
            SET updated_at = ?
            WHERE speciedex_id = ?
            """,
            (timestamp or now(), identifier),
            dictionary=False,
        )

        if commit:
            self.connection.commit()

    def taxon(self, identifier: str) -> Mapping[str, Any] | None:
        return self._execute(
            "SELECT * FROM taxa WHERE speciedex_id = ?",
            (identifier,),
        ).fetchone()

    def source_match(
        self,
        provider: str,
        provider_id: str,
    ) -> str | None:
        row = self._execute(
            """
            SELECT speciedex_id
            FROM source_ids
            WHERE provider = ? AND provider_id = ?
            """,
            (normalize_key(provider), normalize_space(provider_id)),
        ).fetchone()

        return None if row is None else str(row["speciedex_id"])

    def identity_candidates(
        self,
        identity_key: str,
    ) -> list[Mapping[str, Any]]:
        return list(
            self._execute(
                "SELECT * FROM taxa WHERE identity_key = ?",
                (identity_key,),
            ).fetchall()
        )

    def name_candidates(
        self,
        record: Taxon,
    ) -> list[Mapping[str, Any]]:
        return list(
            self._execute(
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
            ).fetchall()
        )

    def synonym_candidates(self, synonym: str) -> list[str]:
        rows = self._execute(
            """
            SELECT DISTINCT speciedex_id
            FROM synonyms
            WHERE synonym_key = ?
            ORDER BY speciedex_id
            """,
            (normalize_key(synonym),),
        ).fetchall()

        return [str(row["speciedex_id"]) for row in rows]

    def attach_assertion(
        self,
        *,
        identifier: str,
        record: Taxon,
        assertion_json: str,
        assertion_hash: str,
        timestamp: str | None = None,
        commit: bool = True,
    ) -> bool:
        self._ensure_writable()

        current_timestamp = timestamp or now()
        normalized_provider = normalize_key(record.provider)
        normalized_provider_id = normalize_space(record.provider_id)

        previous = self._execute(
            """
            SELECT assertion_hash, assertion_json
            FROM assertions
            WHERE provider = ? AND provider_id = ?
            """,
            (normalized_provider, normalized_provider_id),
        ).fetchone()

        changed = bool(
            previous is not None
            and previous["assertion_hash"] != assertion_hash
        )

        try:
            self._execute(
                """
                INSERT INTO source_ids(provider, provider_id, speciedex_id)
                VALUES(?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    speciedex_id = VALUES(speciedex_id)
                """,
                (
                    normalized_provider,
                    normalized_provider_id,
                    identifier,
                ),
                dictionary=False,
            )

            self._execute(
                """
                INSERT INTO assertions(
                    provider, provider_id, speciedex_id, assertion_json,
                    assertion_hash, updated_at
                )
                VALUES(?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    speciedex_id = VALUES(speciedex_id),
                    assertion_json = VALUES(assertion_json),
                    assertion_hash = VALUES(assertion_hash),
                    updated_at = VALUES(updated_at)
                """,
                (
                    normalized_provider,
                    normalized_provider_id,
                    identifier,
                    assertion_json,
                    assertion_hash,
                    current_timestamp,
                ),
                dictionary=False,
            )

            self.replace_synonyms(
                identifier=identifier,
                provider=record.provider,
                synonyms=record.synonyms,
                commit=False,
            )
            self.update_taxon_timestamp(
                identifier,
                current_timestamp,
                commit=False,
            )

            if commit:
                self.connection.commit()
        except self._driver.Error as error:
            if commit:
                self.connection.rollback()
            raise MariaDBIndexError(
                "Unable to attach provider assertion "
                f"{record.provider}:{record.provider_id}: {error}"
            ) from error

        return changed

    def assertion(
        self,
        provider: str,
        provider_id: str,
    ) -> Mapping[str, Any] | None:
        return self._execute(
            """
            SELECT *
            FROM assertions
            WHERE provider = ? AND provider_id = ?
            """,
            (normalize_key(provider), normalize_space(provider_id)),
        ).fetchone()

    def assertions_for_taxon(
        self,
        identifier: str,
    ) -> list[Mapping[str, Any]]:
        return list(
            self._execute(
                """
                SELECT *
                FROM assertions
                WHERE speciedex_id = ?
                ORDER BY provider, provider_id
                """,
                (identifier,),
            ).fetchall()
        )

    def replace_synonyms(
        self,
        *,
        identifier: str,
        provider: str,
        synonyms: Iterable[str],
        commit: bool = True,
    ) -> None:
        self._ensure_writable()

        normalized_provider = normalize_key(provider)

        self._execute(
            """
            DELETE FROM synonyms
            WHERE speciedex_id = ? AND provider = ?
            """,
            (identifier, normalized_provider),
            dictionary=False,
        )

        values = sorted(
            {
                normalize_key(synonym)
                for synonym in synonyms
                if normalize_key(synonym)
            }
        )

        if values:
            self._executemany(
                """
                INSERT IGNORE INTO synonyms(
                    synonym_key, speciedex_id, provider
                )
                VALUES(?, ?, ?)
                """,
                [
                    (synonym, identifier, normalized_provider)
                    for synonym in values
                ],
            )

        if commit:
            self.connection.commit()

    def add_conflict(
        self,
        *,
        conflict_id: str,
        conflict_json: str,
        created_at: str,
        commit: bool = True,
    ) -> bool:
        self._ensure_writable()

        cursor = self._execute(
            """
            INSERT IGNORE INTO conflicts(
                conflict_id, conflict_json, created_at
            )
            VALUES(?, ?, ?)
            """,
            (conflict_id, conflict_json, created_at),
            dictionary=False,
        )
        inserted = cursor.rowcount > 0

        if commit:
            self.connection.commit()

        return inserted

    def conflict(
        self,
        conflict_id: str,
    ) -> Mapping[str, Any] | None:
        return self._execute(
            "SELECT * FROM conflicts WHERE conflict_id = ?",
            (conflict_id,),
        ).fetchone()

    def iter_conflicts(self) -> Iterator[Mapping[str, Any]]:
        cursor = self._execute(
            """
            SELECT *
            FROM conflicts
            ORDER BY created_at, conflict_id
            """
        )
        yield from cursor

    def table_count(self, table: str) -> int:
        if table not in _INDEX_TABLES:
            raise ValueError(f"Unsupported MariaDB table: {table}")

        row = self._execute(
            f"SELECT COUNT(*) AS count FROM `{table}`"
        ).fetchone()
        return int(row["count"] if row else 0)

    @staticmethod
    def _normalized_statuses(
        statuses: Sequence[str] | None,
    ) -> tuple[str, ...]:
        return tuple(
            sorted(
                {
                    normalize_key(status)
                    for status in (statuses or [])
                    if normalize_key(status)
                }
            )
        )

    def rank_counts(
        self,
        *,
        statuses: Sequence[str] | None = None,
    ) -> dict[str, int]:
        query = "SELECT rank, COUNT(*) AS count FROM taxa"
        normalized = self._normalized_statuses(statuses)
        parameters: tuple[Any, ...] = ()

        if normalized:
            placeholders = ",".join("?" for _ in normalized)
            query += f" WHERE status IN ({placeholders})"
            parameters = normalized

        query += " GROUP BY rank ORDER BY count DESC, rank"

        return {
            str(row["rank"]): int(row["count"])
            for row in self._execute(query, parameters).fetchall()
        }

    def status_counts(self) -> dict[str, int]:
        return {
            str(row["status"]): int(row["count"])
            for row in self._execute(
                """
                SELECT status, COUNT(*) AS count
                FROM taxa
                GROUP BY status
                ORDER BY count DESC, status
                """
            ).fetchall()
        }

    def kingdom_counts(
        self,
        *,
        statuses: Sequence[str] | None = None,
    ) -> dict[str, int]:
        query = (
            "SELECT kingdom, COUNT(*) AS count "
            "FROM taxa WHERE kingdom <> ''"
        )
        normalized = self._normalized_statuses(statuses)
        parameters: tuple[Any, ...] = ()

        if normalized:
            placeholders = ",".join("?" for _ in normalized)
            query += f" AND status IN ({placeholders})"
            parameters = normalized

        query += " GROUP BY kingdom ORDER BY count DESC, kingdom"

        return {
            str(row["kingdom"]): int(row["count"])
            for row in self._execute(query, parameters).fetchall()
        }

    def provider_statistics(self) -> dict[str, dict[str, int]]:
        result: dict[str, dict[str, int]] = {}

        for row in self._execute(
            """
            SELECT provider,
                   COUNT(*) AS assertion_count,
                   COUNT(DISTINCT speciedex_id) AS canonical_taxa
            FROM assertions
            GROUP BY provider
            ORDER BY provider
            """
        ).fetchall():
            provider = str(row["provider"])
            result[provider] = {
                "assertions": int(row["assertion_count"]),
                "canonical_taxa": int(row["canonical_taxa"]),
                "source_identifiers": 0,
                "synonyms": 0,
            }

        for row in self._execute(
            """
            SELECT provider, COUNT(*) AS source_count
            FROM source_ids
            GROUP BY provider
            ORDER BY provider
            """
        ).fetchall():
            provider = str(row["provider"])
            result.setdefault(
                provider,
                {
                    "assertions": 0,
                    "canonical_taxa": 0,
                    "source_identifiers": 0,
                    "synonyms": 0,
                },
            )
            result[provider]["source_identifiers"] = int(row["source_count"])

        for row in self._execute(
            """
            SELECT provider, COUNT(*) AS synonym_count
            FROM synonyms
            GROUP BY provider
            ORDER BY provider
            """
        ).fetchall():
            provider = str(row["provider"])
            result.setdefault(
                provider,
                {
                    "assertions": 0,
                    "canonical_taxa": 0,
                    "source_identifiers": 0,
                    "synonyms": 0,
                },
            )
            result[provider]["synonyms"] = int(row["synonym_count"])

        return result

    def latest_provider_assertions(self) -> dict[str, str]:
        return {
            str(row["provider"]): normalize_space(row["latest_assertion"])
            for row in self._execute(
                """
                SELECT provider, MAX(updated_at) AS latest_assertion
                FROM assertions
                GROUP BY provider
                ORDER BY provider
                """
            ).fetchall()
        }

    def orphan_counts(self) -> dict[str, int]:
        result: dict[str, int] = {}

        for table in ("source_ids", "assertions", "synonyms"):
            row = self._execute(
                f"""
                SELECT COUNT(*) AS count
                FROM `{table}` AS child
                LEFT JOIN taxa AS taxon
                  ON taxon.speciedex_id = child.speciedex_id
                WHERE taxon.speciedex_id IS NULL
                """
            ).fetchone()
            result[table] = int(row["count"] if row else 0)

        return result

    def integrity_check(self) -> list[str]:
        """
        Run server/table checks.

        CHECK TABLE may require privileges not granted to restricted runtime
        users. Privilege failures are reported as verification errors.
        """

        errors: list[str] = []

        try:
            for table in _INDEX_TABLES:
                rows = self._execute(
                    f"CHECK TABLE `{table}`",
                ).fetchall()

                for row in rows:
                    message_type = normalize_key(row.get("Msg_type"))
                    message_text = normalize_space(row.get("Msg_text"))

                    if message_type not in {"status", "note"}:
                        errors.append(
                            f"MariaDB table check {table}: "
                            f"{message_type}: {message_text}"
                        )
                    elif (
                        message_type == "status"
                        and normalize_key(message_text) != "ok"
                    ):
                        errors.append(
                            f"MariaDB table check {table}: {message_text}"
                        )
        except self._driver.Error as error:
            errors.append(f"MariaDB integrity check failed: {error}")

        return errors

    def verify(self) -> list[str]:
        errors = self.integrity_check()
        orphans = self.orphan_counts()

        for name, count in orphans.items():
            if count:
                errors.append(
                    f"Orphaned {name.replace('_', ' ')}: {count}"
                )

        schema_version = self.metadata("schema_version")

        if str(schema_version) != str(MARIADB_SCHEMA_VERSION):
            errors.append(
                "MariaDB schema version mismatch: "
                f"expected={MARIADB_SCHEMA_VERSION}, "
                f"actual={schema_version}"
            )

        return errors

    def verify_report(
        self,
        *,
        include_table_counts: bool = True,
    ) -> MariaDBVerification:
        """Return structured verification and diagnostic information."""

        self._ensure_open()

        errors = self.verify()
        warnings: list[str] = []

        if self.read_only:
            warnings.append(
                "MariaDB index is operating in read-only mode."
            )

        table_counts: dict[str, int] = {}

        if include_table_counts:
            for table in _INDEX_TABLES:
                try:
                    table_counts[
                        table
                    ] = self.table_count(
                        table
                    )
                except (
                    MariaDBIndexError,
                    ValueError,
                ) as error:
                    errors.append(
                        f"Unable to count table {table}: {error}"
                    )

        try:
            orphans = self.orphan_counts()
        except MariaDBIndexError as error:
            orphans = {}
            errors.append(
                f"Unable to count orphaned rows: {error}"
            )

        return MariaDBVerification(
            valid=not errors,
            errors=errors,
            warnings=warnings,
            table_counts=table_counts,
            orphan_counts=orphans,
        )

    def ping(self) -> bool:
        """Return whether the MariaDB connection responds."""

        self._ensure_open()

        try:
            ping = getattr(
                self.connection,
                "ping",
                None,
            )

            if callable(
                ping
            ):
                ping()
            else:
                self._execute(
                    "SELECT 1",
                    dictionary=False,
                )

            return True

        except (
            self._driver.Error,
            MariaDBIndexError,
        ):
            return False

    def capabilities(self) -> dict[str, Any]:
        """Return backend capability metadata."""

        return {
            "backend": "mariadb",
            "schema_version": (
                MARIADB_SCHEMA_VERSION
            ),
            "read_only": self.read_only,
            "transactions": True,
            "nested_transactions": True,
            "server_side": True,
            "checkpoint": False,
            "vacuum": True,
            "analyze": True,
            "rebuild": not self.read_only,
        }

    def table_counts(
        self,
    ) -> dict[str, int]:
        """Return counts for all managed index tables."""

        return {
            table: self.table_count(
                table
            )
            for table in _INDEX_TABLES
        }

    def vacuum(self) -> None:
        """Compatibility maintenance operation using OPTIMIZE TABLE."""

        self._ensure_writable()

        if self.read_only:
            raise MariaDBIndexError(
                "Cannot optimize a read-only MariaDB index."
            )

        cursor = self._cursor(dictionary=False)
        for table in _MUTABLE_TABLES:
            cursor.execute(f"OPTIMIZE TABLE `{table}`")

    def analyze(self) -> None:
        self._ensure_open()

        if self.read_only:
            return

        cursor = self._cursor(dictionary=False)
        for table in _INDEX_TABLES:
            cursor.execute(f"ANALYZE TABLE `{table}`")

    def optimize(self) -> None:
        self.analyze()

    def clear(self) -> None:
        self._ensure_writable()

        if self.read_only:
            raise MariaDBIndexError(
                "Cannot clear a read-only MariaDB index."
            )

        with self.transaction():
            for table in _MUTABLE_TABLES:
                self._execute(
                    f"DELETE FROM `{table}`",
                    dictionary=False,
                )

    def rebuild_from_records(
        self,
        records: Iterable[Mapping[str, Any]],
    ) -> int:
        self._ensure_writable()

        if self.read_only:
            raise MariaDBIndexError(
                "Cannot rebuild a read-only MariaDB index."
            )

        inserted = 0

        with self.transaction():
            self._execute(
                "DELETE FROM taxa",
                dictionary=False,
            )

            for value in records:
                if not isinstance(value, Mapping):
                    continue

                identifier = normalize_space(value.get("speciedex_id"))
                identity_key = normalize_space(value.get("identity_key"))
                taxonomy = value.get("taxonomy", {})

                if not isinstance(taxonomy, Mapping):
                    taxonomy = {}

                if not identifier or not identity_key:
                    continue

                primary_json = json.dumps(
                    dict(
                        value
                    ),
                    ensure_ascii=False,
                    sort_keys=True,
                    allow_nan=False,
                    separators=(",", ":"),
                )
                first_seen = normalize_space(value.get("first_seen")) or now()

                self._execute(
                    """
                    INSERT INTO taxa(
                        speciedex_id, identity_key, scientific_name,
                        canonical_name, rank, status, authorship, kingdom,
                        phylum, class_name, order_name, family, genus,
                        record_json, record_hash, volume_file, line_number,
                        created_at, updated_at
                    )
                    VALUES(
                        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                    )
                    """,
                    (
                        identifier,
                        identity_key,
                        normalize_key(value.get("scientific_name")),
                        normalize_key(value.get("canonical_name")),
                        normalize_key(value.get("rank")),
                        normalize_key(value.get("status")),
                        normalize_key(value.get("authorship")),
                        normalize_key(taxonomy.get("kingdom")),
                        normalize_key(taxonomy.get("phylum")),
                        normalize_key(taxonomy.get("class")),
                        normalize_key(taxonomy.get("order")),
                        normalize_key(taxonomy.get("family")),
                        normalize_key(taxonomy.get("genus")),
                        primary_json,
                        normalize_space(value.get("record_hash")),
                        normalize_space(value.get("_volume_file")),
                        max(
                            0,
                            int(
                                value.get(
                                    "_line_number",
                                    0,
                                )
                                or 0
                            ),
                        ),
                        first_seen,
                        first_seen,
                    ),
                    dictionary=False,
                )
                inserted += 1

        return inserted

    def describe(self) -> dict[str, Any]:
        """Return non-secret connection metadata."""

        return {
            "host": self.host,
            "port": self.port,
            "database": self.database_name,
            "user": self.user,
            "read_only": self.read_only,
            "closed": self._closed,
        }

__all__ = [
    "DEFAULT_CONNECT_TIMEOUT_SECONDS",
    "MARIADB_SCHEMA_VERSION",
    "MAX_PORT",
    "MIN_PORT",
    "MariaDBIndex",
    "MariaDBIndexError",
    "MariaDBVerification",
    "validate_sql_identifier",
]
