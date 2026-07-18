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
import sqlite3
import sys
import tempfile
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
VERSION = "3.0.0"
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
    "genera": "genus",
    "families": "family",
    "orders": "order",
    "classes": "class",
    "phyla": "phylum",
    "kingdoms": "kingdom",
}


def now() -> str:
    return datetime.now(timezone.utc).replace(
        microsecond=0
    ).isoformat().replace("+00:00", "Z")


def normalize_space(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def normalize_key(value: Any) -> str:
    return normalize_space(value).casefold()


def safe_int(value: Any, default: int = 0) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 0 else default


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
        self.root = root
        self.volumes = root / "volumes"
        self.revisions = root / "revisions"
        self.conflicts = root / "conflicts"
        self.provider_states = root / "provider-state"
        self.manifest_path = root / "manifest.json"
        self.database_path = root / "index.sqlite3"
        self.target_bytes = target_bytes
        self.maximum_bytes = maximum_bytes

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

    def _initialize_schema(self) -> None:
        self.database.executescript(
            """
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;

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
        self.database.commit()
        self.database.close()

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
            ).encode("utf-8")
        ).hexdigest()

    def active_volume(self) -> dict[str, Any]:
        active_name = self.manifest.get(
            "active_volume"
        )

        for entry in self.manifest["volumes"]:
            if (
                entry["file"] == active_name
                and not entry["sealed"]
            ):
                return entry

        number = len(self.manifest["volumes"]) + 1
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
            json.dumps(
                primary,
                ensure_ascii=False,
            ).encode("utf-8")
        ) + 1
        current_size = (
            path.stat().st_size if path.exists() else 0
        )

        if current_size + estimated > self.maximum_bytes:
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
                ),
                conflict["created_at"],
            ),
        )
        append_jsonl(
            self.conflicts / "unresolved.jsonl",
            [conflict],
        )
        self.database.commit()

    def statistics(self) -> dict[str, int]:
        result: dict[str, int] = {}

        for output_name, rank in RANKS.items():
            placeholders = ",".join(
                "?" for _ in ACTIVE_STATUSES
            )
            query = (
                "SELECT COUNT(*) AS count "
                "FROM taxa "
                "WHERE rank = ? "
                f"AND status IN ({placeholders})"
            )
            row = self.database.execute(
                query,
                (rank, *sorted(ACTIVE_STATUSES)),
            ).fetchone()
            result[output_name] = int(row["count"])

        result["records_archived"] = int(
            self.database.execute(
                "SELECT COUNT(*) AS count FROM taxa"
            ).fetchone()["count"]
        )
        result["source_assertions"] = int(
            self.database.execute(
                """
                SELECT COUNT(*) AS count
                FROM assertions
                """
            ).fetchone()["count"]
        )
        result["synonyms"] = int(
            self.database.execute(
                """
                SELECT COUNT(*) AS count
                FROM synonyms
                """
            ).fetchone()["count"]
        )
        result["unresolved_conflicts"] = int(
            self.database.execute(
                """
                SELECT COUNT(*) AS count
                FROM conflicts
                """
            ).fetchone()["count"]
        )
        result["volumes"] = len(
            self.manifest["volumes"]
        )
        return result

    def verify(self) -> list[str]:
        errors: list[str] = []

        for entry in self.manifest["volumes"]:
            path = self.root / entry["file"]

            if not path.exists():
                errors.append(
                    f"Missing volume: {entry['file']}"
                )
                continue

            if (
                path.stat().st_size
                != entry["size_bytes"]
            ):
                errors.append(
                    f"Size mismatch: {entry['file']}"
                )

            if (
                entry["sealed"]
                and file_hash(path)
                != entry["sha256"]
            ):
                errors.append(
                    f"Hash mismatch: {entry['file']}"
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
        / f"{definition.get('name')}.py"
    )
    if not module_path.exists():
        return (
            False,
            f"missing module: {module_path.name}",
        )

    return (True, "")


def parse_arguments() -> argparse.Namespace:
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
    return parser.parse_args()


def main() -> int:
    args = parse_arguments()

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

    if args.batch_size < 1:
        raise SystemExit(
            "--batch-size must be positive"
        )

    if args.provider_budget < 1:
        raise SystemExit(
            "--provider-budget must be positive"
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

        requested = set(args.provider)
        eligible: list[dict[str, Any]] = []
        skipped: list[dict[str, str]] = []

        for definition in definitions:
            name = str(definition.get("name", ""))

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
            statistics = {
                **archive.statistics(),
                "last_updated": now(),
                "count_method": (
                    "local-deduplicated-append-only-"
                    "canonical-corpus"
                ),
            }
            write_json(
                data_root / "statistics.json",
                statistics,
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
            name = str(definition["name"])
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
