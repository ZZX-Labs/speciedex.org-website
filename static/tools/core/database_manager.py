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

import copy
import os
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator, Mapping, MutableMapping

from .database_backend import (
    DatabaseBackend,
    DatabaseBackendContractError,
    assert_backend_contract,
    backend_diagnostics,
    backend_is_open,
    backend_is_read_only,
    backend_kind,
    backend_path,
)


DATABASE_MANAGER_SCHEMA_VERSION = 1

DATABASE_BACKEND_SQLITE = "sqlite"
DATABASE_BACKEND_MARIADB = "mariadb"

SUPPORTED_DATABASE_BACKENDS = {
    DATABASE_BACKEND_SQLITE,
    DATABASE_BACKEND_MARIADB,
}

DEFAULT_SQLITE_FILENAME = "index.sqlite3"
DEFAULT_SQLITE_TIMEOUT_SECONDS = 60.0

ENV_DATABASE_BACKEND = "SPECIEDEX_DATABASE_BACKEND"
ENV_SQLITE_PATH = "SPECIEDEX_SQLITE_PATH"
ENV_SQLITE_TIMEOUT = "SPECIEDEX_SQLITE_TIMEOUT"
ENV_DATABASE_READ_ONLY = "SPECIEDEX_DATABASE_READ_ONLY"
ENV_MARIADB_HOST = "SPECIEDEX_MARIADB_HOST"
ENV_MARIADB_PORT = "SPECIEDEX_MARIADB_PORT"
ENV_MARIADB_USER = "SPECIEDEX_MARIADB_USER"
ENV_MARIADB_PASSWORD = "SPECIEDEX_MARIADB_PASSWORD"
ENV_MARIADB_DATABASE = "SPECIEDEX_MARIADB_DATABASE"
ENV_MARIADB_UNIX_SOCKET = "SPECIEDEX_MARIADB_UNIX_SOCKET"

_BACKEND_ALIASES = {
    "sqlite": DATABASE_BACKEND_SQLITE,
    "sqlite3": DATABASE_BACKEND_SQLITE,
    "file": DATABASE_BACKEND_SQLITE,
    "local": DATABASE_BACKEND_SQLITE,
    "embedded": DATABASE_BACKEND_SQLITE,
    "mariadb": DATABASE_BACKEND_MARIADB,
    "maria": DATABASE_BACKEND_MARIADB,
    "mysql": DATABASE_BACKEND_MARIADB,
    "server": DATABASE_BACKEND_MARIADB,
}

_SQLITE_CONFIG_KEYS = {
    "path",
    "sqlite_path",
    "timeout",
    "sqlite_timeout",
    "read_only",
}

_MARIADB_CONFIG_KEYS = {
    "host",
    "port",
    "user",
    "password",
    "database",
    "unix_socket",
    "charset",
    "collation",
    "connect_timeout",
    "read_timeout",
    "write_timeout",
    "autocommit",
    "ssl",
    "ssl_ca",
    "ssl_cert",
    "ssl_key",
    "read_only",
}


class DatabaseManagerError(RuntimeError):
    """Raised when a database backend cannot be configured or opened."""


class DatabaseManagerClosedError(DatabaseManagerError):
    """Raised when a closed manager is used."""


class DatabaseManagerConfigurationError(DatabaseManagerError):
    """Raised when backend configuration is invalid."""


class DatabaseManagerReadOnlyError(DatabaseManagerError):
    """Raised when a mutation is attempted through a read-only manager."""


@dataclass(slots=True, frozen=True)
class DatabaseConfiguration:
    """Normalized backend configuration."""

    backend: str
    read_only: bool
    sqlite_path: Path | None = None
    sqlite_timeout: float = DEFAULT_SQLITE_TIMEOUT_SECONDS
    mariadb_config: Mapping[str, Any] = field(
        default_factory=dict
    )

    def to_dict(
        self,
        *,
        redact_secrets: bool = True,
    ) -> dict[str, Any]:
        """Return a JSON-compatible normalized configuration."""

        mariadb = dict(
            self.mariadb_config
        )

        if (
            redact_secrets
            and "password" in mariadb
        ):
            mariadb["password"] = (
                "***"
                if mariadb["password"]
                else ""
            )

        return {
            "schema_version": (
                DATABASE_MANAGER_SCHEMA_VERSION
            ),
            "backend": self.backend,
            "read_only": self.read_only,
            "sqlite_path": (
                self.sqlite_path.as_posix()
                if self.sqlite_path
                is not None
                else None
            ),
            "sqlite_timeout": (
                self.sqlite_timeout
            ),
            "mariadb_config": mariadb,
        }


@dataclass(slots=True, frozen=True)
class DatabaseManagerState:
    """Serializable manager lifecycle and backend state."""

    backend: str
    read_only: bool
    closed: bool
    open: bool
    path: str | None
    diagnostics: Mapping[str, Any] = field(
        default_factory=dict
    )

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible state object."""

        return {
            "schema_version": (
                DATABASE_MANAGER_SCHEMA_VERSION
            ),
            "backend": self.backend,
            "read_only": self.read_only,
            "closed": self.closed,
            "open": self.open,
            "path": self.path,
            "diagnostics": dict(
                self.diagnostics
            ),
        }


def normalize_backend(value: Any) -> str:
    """Return a normalized supported backend name."""

    normalized = str(
        value
        or DATABASE_BACKEND_SQLITE
    ).strip().casefold()

    backend = _BACKEND_ALIASES.get(
        normalized
    )

    if backend is None:
        supported = ", ".join(
            sorted(
                SUPPORTED_DATABASE_BACKENDS
            )
        )

        raise DatabaseManagerConfigurationError(
            f"Unsupported database backend "
            f"{value!r}; supported backends: "
            f"{supported}."
        )

    return backend


def parse_boolean(
    value: Any,
    *,
    default: bool = False,
) -> bool:
    """Parse a tolerant Boolean configuration value."""

    if value is None:
        return bool(default)

    if isinstance(value, bool):
        return value

    if isinstance(value, int):
        return value != 0

    normalized = str(
        value
    ).strip().casefold()

    if normalized in {
        "1",
        "true",
        "yes",
        "on",
        "enabled",
        "read-only",
        "readonly",
    }:
        return True

    if normalized in {
        "0",
        "false",
        "no",
        "off",
        "disabled",
        "",
    }:
        return False

    raise DatabaseManagerConfigurationError(
        f"Invalid Boolean value: {value!r}."
    )


def parse_positive_float(
    value: Any,
    *,
    field_name: str,
    default: float,
) -> float:
    """Parse a finite positive floating-point configuration value."""

    try:
        result = float(
            default
            if value is None
            else value
        )
    except (
        TypeError,
        ValueError,
    ) as error:
        raise DatabaseManagerConfigurationError(
            f"{field_name} must be numeric."
        ) from error

    if (
        result <= 0
        or result != result
        or result in {
            float("inf"),
            float("-inf"),
        }
    ):
        raise DatabaseManagerConfigurationError(
            f"{field_name} must be a finite "
            "positive number."
        )

    return result


def resolve_sqlite_path(
    value: Path | str | None,
    *,
    archive_root: Path | str | None = None,
) -> Path:
    """Resolve a SQLite path from explicit configuration or archive root."""

    if value is None:
        if archive_root is None:
            raise DatabaseManagerConfigurationError(
                "sqlite_path is required when "
                "backend='sqlite'."
            )

        path = (
            Path(archive_root)
            / DEFAULT_SQLITE_FILENAME
        )

    else:
        path = Path(value)

        if (
            not path.is_absolute()
            and archive_root is not None
        ):
            path = (
                Path(archive_root)
                / path
            )

    return path.expanduser()


def normalize_mariadb_config(
    value: Mapping[str, Any] | None,
    *,
    read_only: bool,
) -> dict[str, Any]:
    """Normalize MariaDB configuration without exposing secrets."""

    configuration = dict(
        value or {}
    )

    unknown = sorted(
        set(configuration)
        - _MARIADB_CONFIG_KEYS
    )

    if unknown:
        raise DatabaseManagerConfigurationError(
            "Unsupported MariaDB database "
            "options: "
            + ", ".join(
                unknown
            )
            + "."
        )

    configuration["read_only"] = bool(
        read_only
    )

    if "port" in configuration:
        try:
            port = int(
                configuration["port"]
            )
        except (
            TypeError,
            ValueError,
        ) as error:
            raise (
                DatabaseManagerConfigurationError(
                    "MariaDB port must be "
                    "an integer."
                )
            ) from error

        if not 1 <= port <= 65535:
            raise DatabaseManagerConfigurationError(
                "MariaDB port must be between "
                "1 and 65535."
            )

        configuration["port"] = port

    database_name = str(
        configuration.get(
            "database",
            "",
        )
        or ""
    ).strip()

    if not database_name:
        raise DatabaseManagerConfigurationError(
            "MariaDB configuration requires "
            "a database name."
        )

    configuration["database"] = (
        database_name
    )

    for field_name in (
        "host",
        "user",
        "unix_socket",
        "charset",
        "collation",
        "ssl_ca",
        "ssl_cert",
        "ssl_key",
    ):
        if field_name in configuration:
            configuration[
                field_name
            ] = str(
                configuration[
                    field_name
                ]
                or ""
            ).strip()

    return configuration


def configuration_from_mapping(
    config: Mapping[str, Any],
    *,
    archive_root: Path | str | None = None,
) -> DatabaseConfiguration:
    """Normalize a database-manager mapping."""

    if not isinstance(
        config,
        Mapping,
    ):
        raise DatabaseManagerConfigurationError(
            "Database configuration must "
            "be a mapping."
        )

    values = dict(
        config
    )

    backend = normalize_backend(
        values.pop(
            "backend",
            DATABASE_BACKEND_SQLITE,
        )
    )

    read_only = parse_boolean(
        values.pop(
            "read_only",
            False,
        )
    )

    if backend == DATABASE_BACKEND_SQLITE:
        path_value = values.pop(
            "path",
            values.pop(
                "sqlite_path",
                None,
            ),
        )

        timeout_value = values.pop(
            "timeout",
            values.pop(
                "sqlite_timeout",
                DEFAULT_SQLITE_TIMEOUT_SECONDS,
            ),
        )

        unknown = sorted(
            values
        )

        if unknown:
            raise DatabaseManagerConfigurationError(
                "Unsupported SQLite database "
                "options: "
                + ", ".join(
                    unknown
                )
                + "."
            )

        return DatabaseConfiguration(
            backend=backend,
            read_only=read_only,
            sqlite_path=resolve_sqlite_path(
                path_value,
                archive_root=archive_root,
            ),
            sqlite_timeout=(
                parse_positive_float(
                    timeout_value,
                    field_name=(
                        "SQLite timeout"
                    ),
                    default=(
                        DEFAULT_SQLITE_TIMEOUT_SECONDS
                    ),
                )
            ),
        )

    return DatabaseConfiguration(
        backend=backend,
        read_only=read_only,
        mariadb_config=(
            normalize_mariadb_config(
                values,
                read_only=read_only,
            )
        ),
    )


def configuration_from_environment(
    *,
    environment: Mapping[str, str] | None = None,
    archive_root: Path | str | None = None,
) -> DatabaseConfiguration:
    """Build normalized configuration from Speciedex environment variables."""

    env = (
        environment
        if environment is not None
        else os.environ
    )

    backend = normalize_backend(
        env.get(
            ENV_DATABASE_BACKEND,
            DATABASE_BACKEND_SQLITE,
        )
    )

    read_only = parse_boolean(
        env.get(
            ENV_DATABASE_READ_ONLY,
            False,
        )
    )

    if backend == DATABASE_BACKEND_SQLITE:
        path_value = env.get(
            ENV_SQLITE_PATH
        )

        timeout_value = env.get(
            ENV_SQLITE_TIMEOUT,
            DEFAULT_SQLITE_TIMEOUT_SECONDS,
        )

        return DatabaseConfiguration(
            backend=backend,
            read_only=read_only,
            sqlite_path=resolve_sqlite_path(
                path_value,
                archive_root=archive_root,
            ),
            sqlite_timeout=(
                parse_positive_float(
                    timeout_value,
                    field_name=(
                        "SQLite timeout"
                    ),
                    default=(
                        DEFAULT_SQLITE_TIMEOUT_SECONDS
                    ),
                )
            ),
        )

    mariadb_config: dict[str, Any] = {
        "host": env.get(
            ENV_MARIADB_HOST,
            "127.0.0.1",
        ),
        "port": env.get(
            ENV_MARIADB_PORT,
            3306,
        ),
        "user": env.get(
            ENV_MARIADB_USER,
            "",
        ),
        "password": env.get(
            ENV_MARIADB_PASSWORD,
            "",
        ),
        "database": env.get(
            ENV_MARIADB_DATABASE,
            "",
        ),
        "unix_socket": env.get(
            ENV_MARIADB_UNIX_SOCKET,
            "",
        ),
    }

    return DatabaseConfiguration(
        backend=backend,
        read_only=read_only,
        mariadb_config=(
            normalize_mariadb_config(
                mariadb_config,
                read_only=read_only,
            )
        ),
    )


def _load_sqlite_index() -> type[Any]:
    """Import SQLiteIndex lazily."""

    try:
        from .sqlite_index import SQLiteIndex
    except Exception as error:
        raise DatabaseManagerError(
            "Unable to import SQLiteIndex: "
            f"{error}"
        ) from error

    return SQLiteIndex


def _load_mariadb_index() -> type[Any]:
    """Import MariaDBIndex lazily so SQLite use does not require its driver."""

    try:
        from .mariadb_index import (
            MariaDBIndex,
        )
    except Exception as error:
        raise DatabaseManagerError(
            "Unable to import MariaDBIndex or "
            "its database driver: "
            f"{error}"
        ) from error

    return MariaDBIndex


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
        sqlite_timeout: float = (
            DEFAULT_SQLITE_TIMEOUT_SECONDS
        ),
        read_only: bool = False,
        mariadb_config: (
            Mapping[str, Any]
            | None
        ) = None,
        backend_instance: Any | None = None,
        archive_root: Path | str | None = None,
        **backend_options: Any,
    ) -> None:
        self.backend_name = normalize_backend(
            backend
        )

        self.read_only = bool(
            read_only
        )

        self._closed = False
        self._owns_backend = (
            backend_instance is None
        )

        if backend_instance is not None:
            self.index = (
                assert_backend_contract(
                    backend_instance
                )
            )

            detected = backend_kind(
                self.index
            )

            if (
                detected
                not in {
                    "unknown",
                    self.backend_name,
                }
            ):
                raise DatabaseManagerConfigurationError(
                    "Injected backend does not "
                    "match requested backend: "
                    f"requested={self.backend_name}, "
                    f"detected={detected}."
                )

            self.read_only = (
                backend_is_read_only(
                    self.index
                )
            )

            return

        if (
            self.backend_name
            == DATABASE_BACKEND_SQLITE
        ):
            path = resolve_sqlite_path(
                sqlite_path,
                archive_root=archive_root,
            )

            timeout = parse_positive_float(
                backend_options.pop(
                    "timeout",
                    sqlite_timeout,
                ),
                field_name="SQLite timeout",
                default=(
                    DEFAULT_SQLITE_TIMEOUT_SECONDS
                ),
            )

            if backend_options:
                unknown = ", ".join(
                    sorted(
                        backend_options
                    )
                )

                raise (
                    DatabaseManagerConfigurationError(
                        "Unsupported SQLite "
                        "database options: "
                        f"{unknown}."
                    )
                )

            sqlite_class = (
                _load_sqlite_index()
            )

            self.index = (
                assert_backend_contract(
                    sqlite_class(
                        path,
                        timeout=timeout,
                        read_only=(
                            self.read_only
                        ),
                    )
                )
            )

        else:
            configuration = dict(
                mariadb_config or {}
            )

            configuration.update(
                backend_options
            )

            configuration = (
                normalize_mariadb_config(
                    configuration,
                    read_only=(
                        self.read_only
                    ),
                )
            )

            mariadb_class = (
                _load_mariadb_index()
            )

            self.index = (
                assert_backend_contract(
                    mariadb_class(
                        **configuration
                    )
                )
            )

    @classmethod
    def from_config(
        cls,
        config: Mapping[str, Any],
        *,
        archive_root: Path | str | None = None,
    ) -> "DatabaseManager":
        """Build a manager from a normalized mapping."""

        normalized = (
            configuration_from_mapping(
                config,
                archive_root=archive_root,
            )
        )

        return cls(
            backend=normalized.backend,
            sqlite_path=(
                normalized.sqlite_path
            ),
            sqlite_timeout=(
                normalized.sqlite_timeout
            ),
            read_only=(
                normalized.read_only
            ),
            mariadb_config=(
                normalized.mariadb_config
            ),
            archive_root=archive_root,
        )

    @classmethod
    def from_environment(
        cls,
        *,
        environment: (
            Mapping[str, str]
            | None
        ) = None,
        archive_root: Path | str | None = None,
    ) -> "DatabaseManager":
        """Build a manager from Speciedex environment variables."""

        normalized = (
            configuration_from_environment(
                environment=environment,
                archive_root=archive_root,
            )
        )

        return cls(
            backend=normalized.backend,
            sqlite_path=(
                normalized.sqlite_path
            ),
            sqlite_timeout=(
                normalized.sqlite_timeout
            ),
            read_only=(
                normalized.read_only
            ),
            mariadb_config=(
                normalized.mariadb_config
            ),
            archive_root=archive_root,
        )

    @classmethod
    def from_backend(
        cls,
        backend_instance: Any,
        *,
        backend: str | None = None,
        owns_backend: bool = False,
    ) -> "DatabaseManager":
        """Wrap an already-open backend instance."""

        detected = backend_kind(
            backend_instance
        )

        selected = normalize_backend(
            backend
            if backend is not None
            else (
                detected
                if detected != "unknown"
                else DATABASE_BACKEND_SQLITE
            )
        )

        manager = cls(
            backend=selected,
            backend_instance=(
                backend_instance
            ),
        )

        manager._owns_backend = bool(
            owns_backend
        )

        return manager

    def __enter__(
        self,
    ) -> "DatabaseManager":
        self._ensure_open()
        return self

    def __exit__(
        self,
        exc_type: Any,
        exc_value: Any,
        traceback: Any,
    ) -> None:
        self.close()

    def __getattr__(
        self,
        name: str,
    ) -> Any:
        """
        Delegate backend-specific methods and properties.

        ``index`` is assigned during initialization, so this method is reached
        only for attributes not implemented directly by DatabaseManager.
        """

        try:
            index = object.__getattribute__(
                self,
                "index",
            )
        except AttributeError as error:
            raise AttributeError(
                name
            ) from error

        if object.__getattribute__(
            self,
            "_closed",
        ):
            raise DatabaseManagerClosedError(
                "DatabaseManager is closed."
            )

        return getattr(
            index,
            name,
        )

    def _ensure_open(self) -> None:
        """Reject operations after close."""

        if self._closed:
            raise DatabaseManagerClosedError(
                "DatabaseManager is closed."
            )

    def _ensure_writable(self) -> None:
        """Reject mutating manager operations in read-only mode."""

        self._ensure_open()

        if self.read_only:
            raise DatabaseManagerReadOnlyError(
                "DatabaseManager is read-only."
            )

    @property
    def database(self) -> Any:
        """Return the underlying DB-API connection."""

        self._ensure_open()
        return self.index.database

    @property
    def connection(self) -> Any:
        """Return the underlying DB-API connection."""

        self._ensure_open()
        return self.index.connection

    @property
    def path(self) -> Path | None:
        """Return the SQLite path, or None for a server database."""

        self._ensure_open()
        return backend_path(
            self.index
        )

    @property
    def closed(self) -> bool:
        """Return whether this manager has been closed."""

        return self._closed

    @property
    def owns_backend(self) -> bool:
        """Return whether close() owns and closes the backend."""

        return self._owns_backend

    def transaction(
        self,
    ) -> AbstractContextManager[Any]:
        """Return the selected backend's transaction context manager."""

        self._ensure_open()
        return self.index.transaction()

    def commit(self) -> None:
        """Commit pending backend changes."""

        self._ensure_writable()
        self.index.commit()

    def rollback(self) -> None:
        """Rollback pending backend changes."""

        self._ensure_open()
        self.index.rollback()

    def checkpoint(
        self,
        *,
        truncate: bool = False,
    ) -> None:
        """Checkpoint backend state when supported."""

        self._ensure_writable()
        self.index.checkpoint(
            truncate=truncate
        )

    def close(self) -> None:
        """Close the managed backend exactly once."""

        if self._closed:
            return

        try:
            if self._owns_backend:
                self.index.close()
        finally:
            self._closed = True

    def verify(self) -> list[str]:
        """Return backend integrity and logical-consistency errors."""

        self._ensure_open()

        errors = list(
            self.index.verify()
        )

        if (
            self.backend_name
            not in SUPPORTED_DATABASE_BACKENDS
        ):
            errors.append(
                "Invalid active database backend: "
                f"{self.backend_name}."
            )

        try:
            assert_backend_contract(
                self.index
            )
        except DatabaseBackendContractError as error:
            errors.append(
                str(error)
            )

        if (
            backend_is_read_only(
                self.index
            )
            != self.read_only
        ):
            errors.append(
                "Manager read_only state does not "
                "match backend read_only state."
            )

        if not backend_is_open(
            self.index
        ):
            errors.append(
                "Backend connection appears closed."
            )

        return errors

    def state(self) -> DatabaseManagerState:
        """Return structured lifecycle and backend state."""

        path_value: str | None = None

        if not self._closed:
            path = backend_path(
                self.index
            )

            path_value = (
                path.as_posix()
                if path is not None
                else None
            )

        diagnostics: dict[str, Any] = {}

        if not self._closed:
            diagnostics = (
                backend_diagnostics(
                    self.index
                )
            )

        return DatabaseManagerState(
            backend=self.backend_name,
            read_only=self.read_only,
            closed=self._closed,
            open=(
                False
                if self._closed
                else backend_is_open(
                    self.index
                )
            ),
            path=path_value,
            diagnostics=diagnostics,
        )

    def describe(self) -> dict[str, Any]:
        """Return non-secret backend metadata for diagnostics."""

        result = (
            self.state().to_dict()
        )

        result["owns_backend"] = (
            self._owns_backend
        )

        return result

    def clone_configuration(
        self,
    ) -> DatabaseConfiguration:
        """Return a normalized configuration suitable for a new manager."""

        self._ensure_open()

        if (
            self.backend_name
            == DATABASE_BACKEND_SQLITE
        ):
            path = backend_path(
                self.index
            )

            timeout = getattr(
                self.index,
                "timeout",
                DEFAULT_SQLITE_TIMEOUT_SECONDS,
            )

            return DatabaseConfiguration(
                backend=self.backend_name,
                read_only=self.read_only,
                sqlite_path=path,
                sqlite_timeout=float(
                    timeout
                ),
            )

        description = self.index.describe()

        configuration = {
            key: value
            for key, value
            in dict(description).items()
            if key in _MARIADB_CONFIG_KEYS
            and key != "password"
        }

        configuration["database"] = (
            configuration.get(
                "database"
            )
            or dict(description).get(
                "database"
            )
        )

        return DatabaseConfiguration(
            backend=self.backend_name,
            read_only=self.read_only,
            mariadb_config=configuration,
        )


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


def create_database_manager_from_environment(
    *,
    environment: Mapping[str, str] | None = None,
    archive_root: Path | str | None = None,
) -> DatabaseManager:
    """Construct a manager from Speciedex environment variables."""

    return DatabaseManager.from_environment(
        environment=environment,
        archive_root=archive_root,
    )


__all__ = [
    "DATABASE_BACKEND_MARIADB",
    "DATABASE_BACKEND_SQLITE",
    "DATABASE_MANAGER_SCHEMA_VERSION",
    "DEFAULT_SQLITE_FILENAME",
    "DEFAULT_SQLITE_TIMEOUT_SECONDS",
    "ENV_DATABASE_BACKEND",
    "ENV_DATABASE_READ_ONLY",
    "ENV_MARIADB_DATABASE",
    "ENV_MARIADB_HOST",
    "ENV_MARIADB_PASSWORD",
    "ENV_MARIADB_PORT",
    "ENV_MARIADB_UNIX_SOCKET",
    "ENV_MARIADB_USER",
    "ENV_SQLITE_PATH",
    "ENV_SQLITE_TIMEOUT",
    "SUPPORTED_DATABASE_BACKENDS",
    "DatabaseConfiguration",
    "DatabaseManager",
    "DatabaseManagerClosedError",
    "DatabaseManagerConfigurationError",
    "DatabaseManagerError",
    "DatabaseManagerReadOnlyError",
    "DatabaseManagerState",
    "configuration_from_environment",
    "configuration_from_mapping",
    "create_database_manager",
    "create_database_manager_from_environment",
    "normalize_backend",
    "normalize_mariadb_config",
    "parse_boolean",
    "parse_positive_float",
    "resolve_sqlite_path",
]
