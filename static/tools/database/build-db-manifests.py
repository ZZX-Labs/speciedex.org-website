#!/usr/bin/env python3
"""
Build top-level Speciedex database manifests, checksums, and build state.

Expected location:
    static/tools/database/build-db-manifests.py

This tool consolidates component manifests from the SQLite, MariaDB,
browser-index, and update database layers into a deterministic top-level
manifest. It also writes checksums and a build-state summary suitable for
release automation, verification, and browser consumption.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from datetime import datetime, timezone


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def load_manifest(path: Path) -> dict[str, Any]:
    payload = read_json(path)
    if not isinstance(payload, dict):
        raise ManifestBuildError(
            f"Manifest must contain a JSON object: {path}"
        )
    return payload


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


SCHEMA_VERSION = 2
MANIFEST_FILENAME = "manifest.json"
CHECKSUMS_FILENAME = "checksums.json"
BUILD_STATE_FILENAME = "build-state.json"

EXCLUDED_FILENAMES = {
    CHECKSUMS_FILENAME,
}

DEFAULT_COMPONENTS = {
    "sqlite": "sqlite/manifest.json",
    "mariadb": "mariadb/manifest.json",
    "indexes": "indexes/manifest.json",
    "updates": "updates/manifest.json",
}


class ManifestBuildError(RuntimeError):
    pass


@dataclass(frozen=True)
class FileDigest:
    path: str
    bytes: int
    sha256: str
    sha512: str | None = None
    blake2b: str | None = None


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def human_duration(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def hash_file(path: Path, algorithm: str) -> str:
    try:
        digest = hashlib.new(algorithm)
    except ValueError as error:
        raise ManifestBuildError(
            f"Unsupported checksum algorithm: {algorithm}"
        ) from error

    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)

    return digest.hexdigest()


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ManifestBuildError(f"Required JSON file not found: {path}") from error
    except json.JSONDecodeError as error:
        raise ManifestBuildError(f"Invalid JSON in {path}: {error}") from error
    except OSError as error:
        raise ManifestBuildError(f"Unable to read {path}: {error}") from error


def nested_get(payload: Mapping[str, Any], path: Sequence[str], default: Any = None) -> Any:
    current: Any = payload

    for key in path:
        if not isinstance(current, Mapping) or key not in current:
            return default
        current = current[key]

    return current


def extract_record_total(payload: Mapping[str, Any]) -> int | None:
    candidates = (
        ("totals", "records"),
        ("records",),
        ("record_count",),
        ("totals", "species"),
        ("species",),
    )

    for candidate in candidates:
        value = nested_get(payload, candidate)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, float) and value.is_integer():
            return int(value)
        if isinstance(value, str) and value.strip().isdigit():
            return int(value.strip())

    return None


class DatabaseManifestBuilder:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.db_root = args.db_root.resolve()
        self.started = time.monotonic()
        self.logger = logging.getLogger("speciedex.database.manifests")
        self.component_manifests: dict[str, dict[str, Any]] = {}
        self.file_digests: list[FileDigest] = []

    def configure_logging(self) -> None:
        level = logging.DEBUG if self.args.verbose else logging.INFO
        if self.args.quiet:
            level = logging.WARNING

        logging.basicConfig(
            level=level,
            format="%(asctime)s %(levelname)s %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )

    def validate_environment(self) -> None:
        if not self.db_root.exists():
            raise ManifestBuildError(
                f"Database root does not exist: {self.db_root}"
            )

        if not self.db_root.is_dir():
            raise ManifestBuildError(
                f"Database root is not a directory: {self.db_root}"
            )

        probe = self.db_root / ".speciedex-write-test"
        try:
            probe.write_text("ok\n", encoding="utf-8")
            probe.unlink()
        except OSError as error:
            raise ManifestBuildError(
                f"Database root is not writable: {self.db_root}: {error}"
            ) from error

        for algorithm in self.args.checksum_algorithm:
            if algorithm == "sha256":
                continue
            try:
                hashlib.new(algorithm)
            except ValueError as error:
                raise ManifestBuildError(
                    f"Unsupported checksum algorithm: {algorithm}"
                ) from error

    def component_paths(self) -> dict[str, Path]:
        paths = {
            name: self.db_root / relative
            for name, relative in DEFAULT_COMPONENTS.items()
        }

        for override in self.args.component:
            if "=" not in override:
                raise ManifestBuildError(
                    f"Invalid --component value {override!r}; expected NAME=PATH."
                )
            name, raw_path = override.split("=", 1)
            name = clean_text(name)
            raw_path = clean_text(raw_path)

            if not name or not raw_path:
                raise ManifestBuildError(
                    f"Invalid --component value {override!r}; expected NAME=PATH."
                )

            path = Path(raw_path)
            if not path.is_absolute():
                path = self.db_root / path
            paths[name] = path

        return paths

    def load_components(self) -> None:
        for name, path in sorted(self.component_paths().items()):
            if not path.is_file():
                if name in self.args.optional_component:
                    self.logger.warning(
                        "Optional component manifest not found: %s",
                        path,
                    )
                    continue

                if self.args.allow_missing:
                    self.logger.warning(
                        "Component manifest not found: %s",
                        path,
                    )
                    continue

                raise ManifestBuildError(
                    f"Required component manifest not found: {path}"
                )

            payload = load_manifest(path)
            if not isinstance(payload, dict):
                raise ManifestBuildError(
                    f"Component manifest must contain a JSON object: {path}"
                )

            self.component_manifests[name] = payload

    def should_include_file(self, path: Path) -> bool:
        if not path.is_file():
            return False

        if path.name in EXCLUDED_FILENAMES:
            return False

        relative = path.relative_to(self.db_root).as_posix()

        for pattern in self.args.exclude:
            if path.match(pattern) or Path(relative).match(pattern):
                return False

        return True

    def iter_files(self) -> Iterable[Path]:
        for path in sorted(
            self.db_root.rglob("*"),
            key=lambda item: item.relative_to(self.db_root).as_posix(),
        ):
            if self.should_include_file(path):
                yield path

    def digest_file(self, path: Path) -> FileDigest:
        relative = path.relative_to(self.db_root).as_posix()
        algorithms = set(self.args.checksum_algorithm)

        sha256 = sha256_file(path)
        sha512 = hash_file(path, "sha512") if "sha512" in algorithms else None
        blake2b = hash_file(path, "blake2b") if "blake2b" in algorithms else None

        return FileDigest(
            path=relative,
            bytes=path.stat().st_size,
            sha256=sha256,
            sha512=sha512,
            blake2b=blake2b,
        )

    def build_file_inventory(self) -> None:
        self.file_digests = []

        for index, path in enumerate(self.iter_files(), start=1):
            self.file_digests.append(self.digest_file(path))

            if self.args.progress_every and index % self.args.progress_every == 0:
                self.logger.info("Hashed %d files...", index)

    def parity_summary(self) -> dict[str, Any]:
        sqlite_manifest = self.component_manifests.get("sqlite", {})
        mariadb_manifest = self.component_manifests.get("mariadb", {})
        index_manifest = self.component_manifests.get("indexes", {})

        sqlite_records = extract_record_total(sqlite_manifest)
        mariadb_records = extract_record_total(mariadb_manifest)
        index_records = extract_record_total(index_manifest)

        comparable = sqlite_records is not None and mariadb_records is not None
        equal = comparable and sqlite_records == mariadb_records

        index_equal = None
        if comparable and index_records is not None:
            index_equal = (
                sqlite_records == mariadb_records == index_records
            )

        return {
            "sqlite_records": sqlite_records,
            "mariadb_records": mariadb_records,
            "index_records": index_records,
            "comparable": comparable,
            "equal": equal,
            "index_equal": index_equal,
        }

    def component_summary(self) -> dict[str, Any]:
        summary: dict[str, Any] = {}

        for name, payload in sorted(self.component_manifests.items()):
            summary[name] = {
                "records": extract_record_total(payload),
                "schema_version": payload.get("schema_version"),
                "generated_at": payload.get("generated_at"),
            }

        return summary

    def manifest_payload(self) -> dict[str, Any]:
        generated_at = utc_now()
        parity = self.parity_summary()

        component_paths = {}
        for name, path in sorted(self.component_paths().items()):
            try:
                component_paths[name] = path.relative_to(self.db_root).as_posix()
            except ValueError:
                component_paths[name] = path.as_posix()

        files = [digest.path for digest in self.file_digests]

        payload = {
            "schema_version": SCHEMA_VERSION,
            "generated_at": generated_at,
            "canonical_source": self.args.canonical_source,
            "components": component_paths,
            "component_summary": self.component_summary(),
            "parity": parity,
            "files": files,
            "file_count": len(files),
            "total_bytes": sum(digest.bytes for digest in self.file_digests),
            "checksum_algorithms": sorted(set(self.args.checksum_algorithm)),
            "complete": self.is_complete(parity),
        }

        for name, relative in component_paths.items():
            payload[name] = relative

        return payload

    def checksums_payload(self) -> dict[str, Any]:
        files: dict[str, dict[str, Any]] = {}

        for digest in self.file_digests:
            entry: dict[str, Any] = {
                "sha256": digest.sha256,
                "bytes": digest.bytes,
            }
            if digest.sha512 is not None:
                entry["sha512"] = digest.sha512
            if digest.blake2b is not None:
                entry["blake2b"] = digest.blake2b
            files[digest.path] = entry

        return {
            "schema_version": SCHEMA_VERSION,
            "generated_at": utc_now(),
            "algorithms": sorted(set(self.args.checksum_algorithm)),
            "files": files,
            "file_count": len(files),
            "total_bytes": sum(digest.bytes for digest in self.file_digests),
        }

    def build_state_payload(self, manifest: Mapping[str, Any]) -> dict[str, Any]:
        parity = manifest["parity"]
        elapsed = time.monotonic() - self.started

        state = {
            "schema_version": SCHEMA_VERSION,
            "generated_at": utc_now(),
            "database_root": self.db_root.as_posix(),
            "components": self.component_summary(),
            "parity": parity,
            "files": {
                "count": len(self.file_digests),
                "bytes": sum(digest.bytes for digest in self.file_digests),
            },
            "complete": bool(manifest["complete"]),
            "duration_seconds": round(elapsed, 6),
            "duration": human_duration(elapsed),
        }

        for name, payload in sorted(self.component_manifests.items()):
            state[name] = payload.get("totals", {
                "records": extract_record_total(payload),
            })

        return state

    def is_complete(self, parity: Mapping[str, Any]) -> bool:
        if not parity.get("comparable"):
            return False

        if not parity.get("equal"):
            return False

        if self.args.require_index_parity:
            return parity.get("index_equal") is True

        return True

    def write_outputs(self) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
        manifest = self.manifest_payload()
        checksums = self.checksums_payload()
        build_state = self.build_state_payload(manifest)

        if self.args.dry_run:
            self.logger.info(
                "Dry run: would write %s, %s, and %s",
                self.db_root / MANIFEST_FILENAME,
                self.db_root / CHECKSUMS_FILENAME,
                self.db_root / BUILD_STATE_FILENAME,
            )
            return manifest, checksums, build_state

        atomic_write_json(self.db_root / MANIFEST_FILENAME, manifest)
        atomic_write_json(self.db_root / CHECKSUMS_FILENAME, checksums)
        atomic_write_json(self.db_root / BUILD_STATE_FILENAME, build_state)

        return manifest, checksums, build_state

    def verify_written_outputs(self) -> None:
        if self.args.dry_run or not self.args.verify:
            return

        required = (
            self.db_root / MANIFEST_FILENAME,
            self.db_root / CHECKSUMS_FILENAME,
            self.db_root / BUILD_STATE_FILENAME,
        )

        for path in required:
            payload = read_json(path)
            if not isinstance(payload, dict):
                raise ManifestBuildError(
                    f"Generated file must contain a JSON object: {path}"
                )

        checksums = read_json(self.db_root / CHECKSUMS_FILENAME)
        files = checksums.get("files", {})

        if not isinstance(files, dict):
            raise ManifestBuildError(
                "Generated checksums.json has an invalid files object."
            )

        for relative, expected in files.items():
            path = self.db_root / relative

            if not path.is_file():
                raise ManifestBuildError(
                    f"Checksummed file is missing: {path}"
                )

            actual = sha256_file(path)
            expected_sha256 = expected.get("sha256")

            if actual != expected_sha256:
                raise ManifestBuildError(
                    f"SHA-256 mismatch for {relative}: "
                    f"expected {expected_sha256}, got {actual}"
                )

    def run(self) -> int:
        self.configure_logging()

        try:
            self.validate_environment()
            self.load_components()
            self.build_file_inventory()
            manifest, _, _ = self.write_outputs()
            self.verify_written_outputs()

            if self.args.strict_parity and not manifest["complete"]:
                raise ManifestBuildError(
                    "Database parity verification failed."
                )

        except KeyboardInterrupt:
            self.logger.error("Manifest build interrupted.")
            return 130
        except Exception as error:
            self.logger.error("Manifest build failed: %s", error)
            if self.args.verbose:
                self.logger.exception("Detailed failure")
            return 1

        elapsed = time.monotonic() - self.started

        if self.args.dry_run:
            self.logger.info(
                "Dry run completed for %d database files.",
                len(self.file_digests),
            )
        else:
            self.logger.info(
                "Built top-level database manifests for %d files in %s.",
                len(self.file_digests),
                human_duration(elapsed),
            )

        return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build deterministic top-level Speciedex database manifests, "
            "checksums, and build state."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument(
        "--db-root",
        type=Path,
        default=Path("static/data/db"),
        help="Root directory containing generated database artifacts.",
    )
    parser.add_argument(
        "--canonical-source",
        default="../taxonomy/",
        help="Canonical taxonomy source recorded in the manifest.",
    )
    parser.add_argument(
        "--component",
        action="append",
        default=[],
        metavar="NAME=PATH",
        help=(
            "Override or add a component manifest path. Relative paths are "
            "resolved beneath --db-root. May be supplied multiple times."
        ),
    )
    parser.add_argument(
        "--optional-component",
        action="append",
        default=["updates"],
        metavar="NAME",
        help="Component name that may be absent without failing.",
    )
    parser.add_argument(
        "--allow-missing",
        action="store_true",
        help="Allow any component manifest to be absent.",
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=["logs/**", "*.tmp", "*.lock"],
        metavar="GLOB",
        help="Exclude matching files from the inventory and checksums.",
    )
    parser.add_argument(
        "--checksum-algorithm",
        action="append",
        default=["sha256"],
        choices=("sha256", "sha512", "blake2b"),
        help="Checksum algorithm to include. May be supplied multiple times.",
    )
    parser.add_argument(
        "--strict-parity",
        action="store_true",
        help="Fail when SQLite and MariaDB record totals differ or are missing.",
    )
    parser.add_argument(
        "--require-index-parity",
        action="store_true",
        help="Require browser-index record totals to match database totals.",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Re-read generated files and verify SHA-256 checksums.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build all metadata in memory without writing files.",
    )
    parser.add_argument(
        "--progress-every",
        type=int,
        default=500,
        help="Emit a progress message after hashing this many files; use 0 to disable.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose logging.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress informational logging.",
    )

    args = parser.parse_args(argv)

    if args.progress_every < 0:
        parser.error("--progress-every cannot be negative.")

    if args.verbose and args.quiet:
        parser.error("--verbose and --quiet cannot be used together.")

    args.optional_component = sorted(
        {
            clean_text(value)
            for value in args.optional_component
            if clean_text(value)
        }
    )

    args.checksum_algorithm = sorted(set(args.checksum_algorithm))

    return args


def main(argv: Sequence[str] | None = None) -> int:
    return DatabaseManifestBuilder(parse_args(argv)).run()


if __name__ == "__main__":
    raise SystemExit(main())
