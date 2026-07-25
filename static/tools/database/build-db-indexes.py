#!/usr/bin/env python3
"""
Build browser-facing Speciedex database indexes.

Expected location:
    static/tools/database/build-db-indexes.py

The index builder reads canonical taxonomy records and generates compact,
deterministic JSON indexes for browser and static-site use.

Generated files:

    species.json
    names.json
    providers.json
    taxonomy.json
    shards.json
    manifest.json

Optional sharding may also generate:

    shards/species-00000.json
    shards/species-00001.json
    ...

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
from collections import defaultdict
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence

def _common():
    try:
        from common import atomic_write_json, iter_canonical_records, utc_now
    except ModuleNotFoundError as error:
        raise RuntimeError(
            "Unable to import static/tools/database/common.py. "
            "Run this script from the Speciedex repository with the database "
            "tooling directory intact."
        ) from error
    return atomic_write_json, iter_canonical_records, utc_now


def atomic_write_json(path: Path, payload: Any) -> None:
    writer, _, _ = _common()
    writer(path, payload)


def iter_canonical_records(root: Path):
    _, iterator, _ = _common()
    yield from iterator(root)


def utc_now() -> str:
    _, _, now = _common()
    return now()


SCHEMA_VERSION = 2
DEFAULT_SHARD_SIZE = 25_000
TAXONOMY_RANKS = (
    "domain",
    "kingdom",
    "phylum",
    "class_name",
    "order_name",
    "family",
    "genus",
)


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def normalized_key(value: Any) -> str:
    return " ".join(clean_text(value).casefold().split())


def unique_sorted(values: Iterable[str]) -> list[str]:
    return sorted(set(values))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


@dataclass
class IndexFile:
    filename: str
    records: int
    bytes: int
    sha256: str


class IndexBuildError(RuntimeError):
    pass


class BrowserIndexBuilder:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.taxonomy_root = args.taxonomy_root.resolve()
        self.output = args.output.resolve()
        self.shard_root = self.output / "shards"
        self.logger = logging.getLogger("speciedex.database.indexes")
        self.started = time.monotonic()

        self.species: dict[str, dict[str, Any]] = {}
        self.names: defaultdict[str, list[str]] = defaultdict(list)
        self.providers: defaultdict[str, list[str]] = defaultdict(list)
        self.taxonomy: defaultdict[str, defaultdict[str, list[str]]] = defaultdict(
            lambda: defaultdict(list)
        )
        self.source_records = 0
        self.skipped_records = 0
        self.duplicate_ids = 0
        self.index_files: list[IndexFile] = []

    def configure_logging(self) -> None:
        level = logging.DEBUG if self.args.verbose else logging.INFO
        if self.args.quiet:
            level = logging.WARNING

        logging.basicConfig(
            level=level,
            format="%(asctime)s %(levelname)s %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )

    def validate(self) -> None:
        if not self.taxonomy_root.exists():
            raise IndexBuildError(
                f"Taxonomy root does not exist: {self.taxonomy_root}"
            )

        if not self.taxonomy_root.is_dir():
            raise IndexBuildError(
                f"Taxonomy root is not a directory: {self.taxonomy_root}"
            )

        if self.args.shard_size < 1:
            raise IndexBuildError("--shard-size must be at least 1.")

        self.output.mkdir(parents=True, exist_ok=True)

        probe = self.output / ".speciedex-write-test"
        try:
            probe.write_text("ok\n", encoding="utf-8")
            probe.unlink()
        except OSError as error:
            raise IndexBuildError(
                f"Output directory is not writable: {self.output}: {error}"
            ) from error

    def compact_record(self, record: Mapping[str, Any]) -> dict[str, Any]:
        identifier = clean_text(record.get("speciedex_id"))
        if not identifier:
            raise IndexBuildError("Canonical record is missing speciedex_id.")

        compact: dict[str, Any] = {
            "id": identifier,
            "scientific_name": clean_text(record.get("scientific_name")),
            "common_name": clean_text(record.get("common_name")),
            "rank": clean_text(record.get("rank")),
            "provider": clean_text(record.get("provider")),
            "indexed_at": clean_text(record.get("indexed_at")),
        }

        if self.args.include_canonical_name:
            compact["canonical_name"] = clean_text(record.get("canonical_name"))

        if self.args.include_taxonomy:
            for rank in TAXONOMY_RANKS:
                compact[rank] = clean_text(record.get(rank))

        return compact

    def ingest(self) -> None:
        for record in iter_canonical_records(self.taxonomy_root):
            self.source_records += 1

            try:
                compact = self.compact_record(record)
            except Exception as error:
                self.skipped_records += 1
                if self.args.strict:
                    raise
                self.logger.warning(
                    "Skipping invalid canonical record %d: %s",
                    self.source_records,
                    error,
                )
                continue

            identifier = compact["id"]

            if identifier in self.species:
                self.duplicate_ids += 1
                if self.args.strict:
                    raise IndexBuildError(
                        f"Duplicate speciedex_id encountered: {identifier}"
                    )

            self.species[identifier] = compact

            for value in (
                record.get("scientific_name", ""),
                record.get("canonical_name", ""),
                record.get("common_name", ""),
            ):
                key = normalized_key(value)
                if key:
                    self.names[key].append(identifier)

            provider = clean_text(record.get("provider")) or "unknown"
            self.providers[provider].append(identifier)

            for rank in TAXONOMY_RANKS:
                value = clean_text(record.get(rank))
                if value:
                    self.taxonomy[rank][value].append(identifier)

            if (
                self.args.progress_every
                and self.source_records % self.args.progress_every == 0
            ):
                self.logger.info(
                    "Indexed %d source records...",
                    self.source_records,
                )

    def normalize_indexes(self) -> tuple[
        dict[str, dict[str, Any]],
        dict[str, list[str]],
        dict[str, list[str]],
        dict[str, dict[str, list[str]]],
    ]:
        species = dict(sorted(self.species.items()))

        names = {
            key: unique_sorted(values)
            for key, values in sorted(self.names.items())
        }

        providers = {
            key: unique_sorted(values)
            for key, values in sorted(self.providers.items())
        }

        taxonomy = {
            rank: {
                value: unique_sorted(identifiers)
                for value, identifiers in sorted(values.items())
            }
            for rank, values in sorted(self.taxonomy.items())
        }

        return species, names, providers, taxonomy

    def write_index(
        self,
        filename: str,
        payload: Any,
        *,
        records: int,
    ) -> Path:
        path = self.output / filename

        if self.args.dry_run:
            self.logger.info("Would write %s", path)
            return path

        atomic_write_json(path, payload)

        self.index_files.append(
            IndexFile(
                filename=filename,
                records=records,
                bytes=json_size(path),
                sha256=sha256_file(path),
            )
        )
        return path

    def clean_shards(self) -> None:
        if not self.shard_root.exists():
            return

        for path in self.shard_root.glob("species-*.json"):
            path.unlink(missing_ok=True)

    def write_shards(
        self,
        species: Mapping[str, Mapping[str, Any]],
    ) -> list[dict[str, Any]]:
        if not self.args.shard:
            return []

        self.shard_root.mkdir(parents=True, exist_ok=True)

        if self.args.clean:
            self.clean_shards()

        entries = list(species.items())
        shards: list[dict[str, Any]] = []

        for shard_number, start in enumerate(
            range(0, len(entries), self.args.shard_size)
        ):
            chunk = entries[start : start + self.args.shard_size]
            filename = f"species-{shard_number:05d}.json"
            relative = f"shards/{filename}"
            payload = dict(chunk)
            path = self.shard_root / filename

            if not self.args.dry_run:
                atomic_write_json(path, payload)

            descriptor = {
                "filename": relative,
                "records": len(chunk),
                "first_id": chunk[0][0] if chunk else "",
                "last_id": chunk[-1][0] if chunk else "",
                "bytes": 0 if self.args.dry_run else json_size(path),
                "sha256": "" if self.args.dry_run else sha256_file(path),
            }
            shards.append(descriptor)

        return shards

    def write_outputs(self) -> None:
        species, names, providers, taxonomy = self.normalize_indexes()

        self.write_index(
            "species.json",
            species,
            records=len(species),
        )
        self.write_index(
            "names.json",
            names,
            records=len(names),
        )
        self.write_index(
            "providers.json",
            providers,
            records=len(providers),
        )
        self.write_index(
            "taxonomy.json",
            taxonomy,
            records=sum(len(values) for values in taxonomy.values()),
        )

        shard_index = self.write_shards(species)

        if self.args.shard:
            self.write_index(
                "shards.json",
                {
                    "schema_version": SCHEMA_VERSION,
                    "generated_at": utc_now(),
                    "shard_size": self.args.shard_size,
                    "records": len(species),
                    "shards": shard_index,
                },
                records=len(shard_index),
            )

        manifest = {
            "schema_version": SCHEMA_VERSION,
            "generated_at": utc_now(),
            "source": self.taxonomy_root.as_posix(),
            "output": self.output.as_posix(),
            "source_records": self.source_records,
            "records": len(species),
            "skipped_records": self.skipped_records,
            "duplicate_ids": self.duplicate_ids,
            "name_keys": len(names),
            "providers": len(providers),
            "taxonomy_values": {
                rank: len(values)
                for rank, values in taxonomy.items()
            },
            "sharded": bool(self.args.shard),
            "shard_size": self.args.shard_size if self.args.shard else None,
            "indexes": [
                asdict(index_file)
                for index_file in self.index_files
            ],
            "duration_seconds": round(time.monotonic() - self.started, 6),
        }

        self.write_index(
            "manifest.json",
            manifest,
            records=len(species),
        )

    def verify_outputs(self) -> None:
        if self.args.dry_run or not self.args.verify:
            return

        required = [
            self.output / "species.json",
            self.output / "names.json",
            self.output / "providers.json",
            self.output / "taxonomy.json",
            self.output / "manifest.json",
        ]

        if self.args.shard:
            required.append(self.output / "shards.json")

        for path in required:
            if not path.is_file():
                raise IndexBuildError(f"Expected index file was not created: {path}")

            try:
                json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as error:
                raise IndexBuildError(
                    f"Invalid JSON generated at {path}: {error}"
                ) from error

    def run(self) -> int:
        self.configure_logging()

        try:
            self.validate()

            if self.args.clean:
                for filename in (
                    "species.json",
                    "names.json",
                    "providers.json",
                    "taxonomy.json",
                    "shards.json",
                    "manifest.json",
                ):
                    (self.output / filename).unlink(missing_ok=True)

            self.ingest()
            self.write_outputs()
            self.verify_outputs()

        except KeyboardInterrupt:
            self.logger.error("Index build interrupted.")
            return 130
        except Exception as error:
            self.logger.error("Index build failed: %s", error)
            if self.args.verbose:
                self.logger.exception("Detailed failure")
            return 1

        elapsed = time.monotonic() - self.started

        if self.args.dry_run:
            self.logger.info(
                "Dry run completed for %d source records.",
                self.source_records,
            )
        else:
            self.logger.info(
                "Built browser indexes for %d records in %.2f seconds.",
                len(self.species),
                elapsed,
            )

        return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build deterministic Speciedex browser indexes.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument(
        "--taxonomy-root",
        type=Path,
        default=Path("static/data/taxonomy"),
        help="Root directory containing canonical taxonomy records.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("static/data/db/indexes"),
        help="Destination directory for generated browser indexes.",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Remove existing generated index files before rebuilding.",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Fail immediately on invalid records or duplicate identifiers.",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Parse generated JSON files after writing them.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Read and index records without writing files.",
    )
    parser.add_argument(
        "--shard",
        action="store_true",
        help="Write sharded species indexes for lower browser memory usage.",
    )
    parser.add_argument(
        "--shard-size",
        type=int,
        default=DEFAULT_SHARD_SIZE,
        help="Maximum number of species records per shard.",
    )
    parser.add_argument(
        "--include-canonical-name",
        action="store_true",
        help="Include canonical_name in compact species records.",
    )
    parser.add_argument(
        "--include-taxonomy",
        action="store_true",
        help="Include taxonomy rank fields in compact species records.",
    )
    parser.add_argument(
        "--progress-every",
        type=int,
        default=100_000,
        help="Emit a progress message after this many source records; use 0 to disable.",
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

    if args.shard_size < 1:
        parser.error("--shard-size must be at least 1.")

    if args.progress_every < 0:
        parser.error("--progress-every cannot be negative.")

    if args.verbose and args.quiet:
        parser.error("--verbose and --quiet cannot be used together.")

    return args


def main(argv: Sequence[str] | None = None) -> int:
    return BrowserIndexBuilder(parse_args(argv)).run()


if __name__ == "__main__":
    raise SystemExit(main())
