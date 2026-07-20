#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/database_manager.py

Backend-neutral database-index manager for the Speciedex archive.

The append-only JSONL volumes remain the canonical durable archive. Database
backends are rebuildable indexes used for lookup, reconciliation, statistics,
health checks, and administrative maintenance.

Supported backends:

- SQLite through core.sqlite_index.SQLiteIndex
- MariaDB through core.mariadb_index.MariaDBIndex

Copyright (c) 2026 ZZX-Laboratories
Licensed under the MIT License.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterator, Mapping

from .mariadb_index import MariaDBIndex
from .sqlite_index import SQLiteIndex


DATABASE_BACKEND_SQLITE = "sqlite"
DATABASE_BACKEND_MARIADB = "mariadb"

SUPPORTED_DATABASE_BACKENDS = {
    DATABASE_BACKEND_SQLITE,
    DATABASE_BACKEND_MARIADB,
}

_BACKEND_ALIASES = {
    "sqlite": DATABASE_BACKEND_SQLITE,
    "sqlite3": DATABASE_BACKEND_SQLITE,
    "file": DATABASE_BACKEND_SQLITE,
    "local": DATABASE_BACKEND_SQLITE,
    "mariadb": DATABASE_BACKEND_MARIADB,
    "maria": DATABASE_BACKEND_MARIADB,
    "mysql": DATABASE_BACKEND_MARIADB,
}


class DatabaseManagerError(RuntimeError):
    """Raised when a database backend cannot be configured or opened."""


def normalize_backend(value: Any) -> str:
    """Return a normalized supported backend name."""

    normalized = str(value or DATABASE_BACKEND_SQLITE).strip().casefold()
    backend = _BACKEND_ALIASES.get(normalized)

    if backend is None:
        supported = ", ".join(sorted(SUPPORTED_DATABASE_BACKENDS))
        raise DatabaseManagerError(
            f"Unsupported database backend {value!r}; supported backends: "
            f"{supported}."
        )

    return backend


class DatabaseManager:
    """
    Backend-neutral facade over SQLiteIndex and MariaDBIndex.

    Unknown attributes and methods are delegated to the selected backend. This
    preserves the complete SQLiteIndex/MariaDBIndex API while allowing Archive
    and the other core modules to depend on one stable object.
    """

    def __init__(
        self,
        *,
        backend: str = DATABASE_BACKEND_SQLITE,
        sqlite_path: Path | str | None = None,
        sqlite_timeout: float = 60.0,
        read_only: bool = False,
        mariadb_config: Mapping[str, Any] | None = None,
        **backend_options: Any,
    ) -> None:
        self.backend_name = normalize_backend(backend)
        self.read_only = bool(read_only)
        self._closed = False

        if self.backend_name == DATABASE_BACKEND_SQLITE:
            if sqlite_path is None:
                raise DatabaseManagerError(
                    "sqlite_path is required when backend='sqlite'."
                )

            allowed = {
                "timeout": backend_options.pop(
                    "timeout",
                    sqlite_timeout,
                ),
                "read_only": self.read_only,
            }

            if backend_options:
                unknown = ", ".join(sorted(backend_options))
                raise DatabaseManagerError(
                    f"Unsupported SQLite database options: {unknown}."
                )

            self.index: SQLiteIndex | MariaDBIndex = SQLiteIndex(
                Path(sqlite_path),
                **allowed,
            )

        else:
            configuration = dict(mariadb_config or {})
            configuration.update(backend_options)
            configuration.setdefault("read_only", self.read_only)

            if not configuration.get("database"):
                raise DatabaseManagerError(
                    "MariaDB configuration requires a database name."
                )

            self.index = MariaDBIndex(**configuration)

    @classmethod
    def from_config(
        cls,
        config: Mapping[str, Any],
        *,
        archive_root: Path | str | None = None,
    ) -> "DatabaseManager":
        """
        Build a manager from a mapping.

        Accepted SQLite example::

            {
                "backend": "sqlite",
                "path": "static/data/taxonomy/index.sqlite3",
                "timeout": 60,
                "read_only": false
            }

        Accepted MariaDB example::

            {
                "backend": "mariadb",
                "host": "127.0.0.1",
                "port": 3306,
                "user": "speciedex",
                "password": "...",
                "database": "speciedex",
                "read_only": false
            }
        """

        if not isinstance(config, Mapping):
            raise DatabaseManagerError(
                "Database configuration must be a mapping."
            )

        values = dict(config)
        backend = normalize_backend(values.pop("backend", "sqlite"))
        read_only = bool(values.pop("read_only", False))

        if backend == DATABASE_BACKEND_SQLITE:
            path_value = values.pop(
                "path",
                values.pop("sqlite_path", None),
            )

            if path_value is None and archive_root is not None:
                path_value = Path(archive_root) / "index.sqlite3"

            timeout = float(values.pop("timeout", 60.0))

            if values:
                unknown = ", ".join(sorted(values))
                raise DatabaseManagerError(
                    f"Unsupported SQLite database options: {unknown}."
                )

            return cls(
                backend=backend,
                sqlite_path=path_value,
                sqlite_timeout=timeout,
                read_only=read_only,
            )

        values["read_only"] = read_only
        return cls(
            backend=backend,
            mariadb_config=values,
        )

    def __enter__(self) -> "DatabaseManager":
        return self

    def __exit__(
        self,
        exc_type: Any,
        exc_value: Any,
        traceback: Any,
    ) -> None:
        self.close()

    def __getattr__(self, name: str) -> Any:
        """
        Delegate backend-specific methods and properties.

        ``index`` is assigned during initialization, so this method is reached
        only for attributes not implemented directly by DatabaseManager.
        """

        try:
            index = object.__getattribute__(self, "index")
        except AttributeError as error:
            raise AttributeError(name) from error

        return getattr(index, name)

    @property
    def database(self) -> Any:
        """Return the underlying DB-API connection."""

        return self.index.database

    @property
    def connection(self) -> Any:
        """Return the underlying DB-API connection."""

        return self.index.connection

    @property
    def path(self) -> Path | None:
        """Return the SQLite path, or None for a server database."""

        value = getattr(self.index, "path", None)
        return Path(value) if value is not None else None

    def transaction(self) -> Iterator[Any]:
        """Return the selected backend's transaction context manager."""

        return self.index.transaction()

    def commit(self) -> None:
        self.index.commit()

    def rollback(self) -> None:
        self.index.rollback()

    def close(self) -> None:
        if self._closed:
            return

        self.index.close()
        self._closed = True

    def verify(self) -> list[str]:
        """Return backend integrity and logical-consistency errors."""

        errors = list(self.index.verify())

        if self.backend_name not in SUPPORTED_DATABASE_BACKENDS:
            errors.append(
                f"Invalid active database backend: {self.backend_name}."
            )

        return errors

    def describe(self) -> dict[str, Any]:
        """Return non-secret backend metadata for diagnostics."""

        result: dict[str, Any] = {
            "backend": self.backend_name,
            "read_only": self.read_only,
            "closed": self._closed,
        }

        if self.backend_name == DATABASE_BACKEND_SQLITE:
            result["path"] = (
                self.path.as_posix()
                if self.path is not None
                else None
            )
        else:
            result.update(self.index.describe())

        return result


def create_database_manager(
    config: Mapping[str, Any],
    *,
    archive_root: Path | str | None = None,
) -> DatabaseManager:
    """Compatibility factory for constructing a DatabaseManager."""

    return DatabaseManager.from_config(
        config,
        archive_root=archive_root,
    )
