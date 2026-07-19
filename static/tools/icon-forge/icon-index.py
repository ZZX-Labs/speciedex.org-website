#!/usr/bin/env python3
"""
Speciedex Icon Forge SQLite index manager.

Creates and maintains namespaced icon-generation tables inside the existing
taxonomy database without modifying unrelated archive tables.

Expected location:
    static/tools/icon-forge/icon-index.py

Default database:
    static/data/taxonomy/index.sqlite3

Commands:
    init
        Create or migrate the icon-generation schema.

    import-jsonl
        Import normalized/enriched taxonomic JSONL records into the queue.

    queue
        Print queue statistics.

    reset-icons
        Mark all indexed taxa as needing icon generation.

Examples:
    python static/tools/icon-forge/icon-index.py init

    python static/tools/icon-forge/icon-index.py import-jsonl \
      --input static/data/taxonomy/normalized/all-taxa-enriched.jsonl

    python static/tools/icon-forge/icon-index.py queue
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

DEFAULT_DB = Path("static/data/taxonomy/index.sqlite3")
SCHEMA_VERSION = 1
GENERATOR_NAMESPACE = "speciedex-icon-forge"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def canonical_text(value: Any) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).strip()


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def stable_taxon_key(record: Mapping[str, Any]) -> str:
    identifier = canonical_text(
        record.get("id")
        or record.get("identifier")
        or record.get("taxon_id")
    )
    if identifier:
        return identifier

    scientific_name = canonical_text(
        record.get("scientific_name")
        or record.get("canonical_name")
        or record.get("name")
        or record.get("taxon")
    )
    rank = canonical_text(record.get("rank") or "unranked").lower()
    lineage = record.get("lineage") or []

    material = canonical_json(
        {
            "scientific_name": scientific_name,
            "rank": rank,
            "lineage": lineage,
        }
    )
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()
    return f"speciedex:auto:{digest}"


def source_record_hash(record: Mapping[str, Any]) -> str:
    return hashlib.sha256(
        canonical_json(record).encode("utf-8")
    ).hexdigest()


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)

    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = NORMAL")
    connection.execute("PRAGMA busy_timeout = 30000")
    return connection


def migrate(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS iconforge_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS iconforge_taxa (
            taxon_key TEXT PRIMARY KEY,
            provider TEXT NOT NULL DEFAULT '',
            provider_id TEXT NOT NULL DEFAULT '',
            scientific_name TEXT NOT NULL,
            canonical_name TEXT NOT NULL DEFAULT '',
            common_name TEXT NOT NULL DEFAULT '',
            rank TEXT NOT NULL DEFAULT 'unranked',
            status TEXT NOT NULL DEFAULT 'accepted',
            parent_key TEXT NOT NULL DEFAULT '',
            accepted_key TEXT NOT NULL DEFAULT '',
            lineage_json TEXT NOT NULL DEFAULT '[]',
            traits_json TEXT NOT NULL DEFAULT '{}',
            source_record_hash TEXT NOT NULL,
            source_updated_at TEXT NOT NULL,
            indexed_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_iconforge_taxa_rank
            ON iconforge_taxa(rank);

        CREATE INDEX IF NOT EXISTS idx_iconforge_taxa_parent
            ON iconforge_taxa(parent_key);

        CREATE INDEX IF NOT EXISTS idx_iconforge_taxa_accepted
            ON iconforge_taxa(accepted_key);

        CREATE INDEX IF NOT EXISTS idx_iconforge_taxa_name
            ON iconforge_taxa(scientific_name);

        CREATE TABLE IF NOT EXISTS iconforge_icons (
            taxon_key TEXT PRIMARY KEY,
            identity_sha256 TEXT NOT NULL DEFAULT '',
            lineage_sha256 TEXT NOT NULL DEFAULT '',
            generator_version TEXT NOT NULL DEFAULT '',
            icon_path TEXT NOT NULL DEFAULT '',
            icon_sha256 TEXT NOT NULL DEFAULT '',
            icon_size INTEGER NOT NULL DEFAULT 0,
            visual_salt INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending', 'rendering', 'ready', 'failed', 'stale')),
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT NOT NULL DEFAULT '',
            queued_at TEXT NOT NULL,
            started_at TEXT NOT NULL DEFAULT '',
            generated_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL,
            FOREIGN KEY (taxon_key)
                REFERENCES iconforge_taxa(taxon_key)
                ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_iconforge_icons_state
            ON iconforge_icons(state);

        CREATE INDEX IF NOT EXISTS idx_iconforge_icons_identity
            ON iconforge_icons(identity_sha256);

        CREATE TABLE IF NOT EXISTS iconforge_events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            taxon_key TEXT NOT NULL DEFAULT '',
            event_type TEXT NOT NULL,
            message TEXT NOT NULL DEFAULT '',
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_iconforge_events_taxon
            ON iconforge_events(taxon_key);

        CREATE TABLE IF NOT EXISTS iconforge_runs (
            run_id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT NOT NULL,
            finished_at TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'running',
            generator_version TEXT NOT NULL DEFAULT '',
            requested_size INTEGER NOT NULL DEFAULT 0,
            selected_count INTEGER NOT NULL DEFAULT 0,
            generated_count INTEGER NOT NULL DEFAULT 0,
            reused_count INTEGER NOT NULL DEFAULT 0,
            failed_count INTEGER NOT NULL DEFAULT 0,
            notes TEXT NOT NULL DEFAULT ''
        );
        """
    )

    now = utc_now()
    connection.execute(
        """
        INSERT INTO iconforge_metadata(key, value, updated_at)
        VALUES('schema_version', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        """,
        (str(SCHEMA_VERSION), now),
    )
    connection.execute(
        """
        INSERT INTO iconforge_metadata(key, value, updated_at)
        VALUES('namespace', ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        """,
        (GENERATOR_NAMESPACE, now),
    )
    connection.commit()


def iter_jsonl(path: Path) -> Iterable[tuple[int, Mapping[str, Any]]]:
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue

            payload = json.loads(line)
            if not isinstance(payload, Mapping):
                raise ValueError(
                    f"{path}:{line_number}: record must be a JSON object"
                )

            yield line_number, payload


def import_record(
    connection: sqlite3.Connection,
    record: Mapping[str, Any],
) -> tuple[str, bool, bool]:
    now = utc_now()
    taxon_key = stable_taxon_key(record)

    scientific_name = canonical_text(
        record.get("scientific_name")
        or record.get("canonical_name")
        or record.get("name")
        or record.get("taxon")
    )
    if not scientific_name:
        raise ValueError("record is missing a scientific name")

    canonical_name = canonical_text(
        record.get("canonical_name") or scientific_name
    )
    common_name = canonical_text(record.get("common_name"))
    rank = canonical_text(record.get("rank") or "unranked").lower()
    status = canonical_text(record.get("status") or "accepted").lower()
    provider = canonical_text(record.get("source") or record.get("provider"))
    provider_id = canonical_text(
        record.get("source_id") or record.get("provider_id")
    )
    parent_key = canonical_text(record.get("parent_id") or record.get("parent_key"))
    accepted_key = canonical_text(
        record.get("accepted_id") or record.get("accepted_key")
    )
    lineage_json = canonical_json(record.get("lineage") or [])
    traits_json = canonical_json(record.get("traits") or {})
    record_hash = source_record_hash(record)
    source_updated_at = canonical_text(record.get("updated_at")) or now

    previous = connection.execute(
        """
        SELECT source_record_hash
        FROM iconforge_taxa
        WHERE taxon_key = ?
        """,
        (taxon_key,),
    ).fetchone()

    inserted = previous is None
    changed = inserted or previous["source_record_hash"] != record_hash

    connection.execute(
        """
        INSERT INTO iconforge_taxa(
            taxon_key,
            provider,
            provider_id,
            scientific_name,
            canonical_name,
            common_name,
            rank,
            status,
            parent_key,
            accepted_key,
            lineage_json,
            traits_json,
            source_record_hash,
            source_updated_at,
            indexed_at,
            updated_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(taxon_key) DO UPDATE SET
            provider = excluded.provider,
            provider_id = excluded.provider_id,
            scientific_name = excluded.scientific_name,
            canonical_name = excluded.canonical_name,
            common_name = excluded.common_name,
            rank = excluded.rank,
            status = excluded.status,
            parent_key = excluded.parent_key,
            accepted_key = excluded.accepted_key,
            lineage_json = excluded.lineage_json,
            traits_json = excluded.traits_json,
            source_record_hash = excluded.source_record_hash,
            source_updated_at = excluded.source_updated_at,
            updated_at = excluded.updated_at
        """,
        (
            taxon_key,
            provider,
            provider_id,
            scientific_name,
            canonical_name,
            common_name,
            rank,
            status,
            parent_key,
            accepted_key,
            lineage_json,
            traits_json,
            record_hash,
            source_updated_at,
            now,
            now,
        ),
    )

    connection.execute(
        """
        INSERT INTO iconforge_icons(
            taxon_key,
            state,
            queued_at,
            updated_at
        )
        VALUES(?, 'pending', ?, ?)
        ON CONFLICT(taxon_key) DO UPDATE SET
            state = CASE
                WHEN ? = 1 THEN 'stale'
                ELSE iconforge_icons.state
            END,
            queued_at = CASE
                WHEN ? = 1 THEN excluded.queued_at
                ELSE iconforge_icons.queued_at
            END,
            updated_at = excluded.updated_at
        """,
        (
            taxon_key,
            now,
            now,
            1 if changed and not inserted else 0,
            1 if changed and not inserted else 0,
        ),
    )

    event_type = "taxon_inserted" if inserted else (
        "taxon_changed" if changed else "taxon_unchanged"
    )
    connection.execute(
        """
        INSERT INTO iconforge_events(
            taxon_key,
            event_type,
            message,
            payload_json,
            created_at
        )
        VALUES(?, ?, ?, ?, ?)
        """,
        (
            taxon_key,
            event_type,
            scientific_name,
            canonical_json(
                {
                    "rank": rank,
                    "source_record_hash": record_hash,
                }
            ),
            now,
        ),
    )

    return taxon_key, inserted, changed


def command_init(args: argparse.Namespace) -> int:
    database = Path(args.database)
    with connect(database) as connection:
        migrate(connection)

    print(
        f"database={database.as_posix()} "
        f"schema_version={SCHEMA_VERSION}"
    )
    return 0


def command_import_jsonl(args: argparse.Namespace) -> int:
    database = Path(args.database)
    input_path = Path(args.input)

    inserted = 0
    changed = 0
    unchanged = 0
    failed = 0

    with connect(database) as connection:
        migrate(connection)

        for line_number, record in iter_jsonl(input_path):
            try:
                _, was_inserted, was_changed = import_record(
                    connection,
                    record,
                )

                if was_inserted:
                    inserted += 1
                elif was_changed:
                    changed += 1
                else:
                    unchanged += 1

            except Exception as exc:
                failed += 1
                print(
                    f"{input_path}:{line_number}: {exc}",
                    file=sys.stderr,
                )

                if args.fail_fast:
                    connection.rollback()
                    return 1

        connection.commit()

    print(
        f"inserted={inserted} "
        f"changed={changed} "
        f"unchanged={unchanged} "
        f"failed={failed}"
    )
    return 1 if failed and args.strict else 0


def command_queue(args: argparse.Namespace) -> int:
    database = Path(args.database)

    with connect(database) as connection:
        migrate(connection)

        rows = connection.execute(
            """
            SELECT
                state,
                COUNT(*) AS count
            FROM iconforge_icons
            GROUP BY state
            ORDER BY state
            """
        ).fetchall()

        total_taxa = connection.execute(
            "SELECT COUNT(*) FROM iconforge_taxa"
        ).fetchone()[0]

        rank_rows = connection.execute(
            """
            SELECT
                rank,
                COUNT(*) AS count
            FROM iconforge_taxa
            GROUP BY rank
            ORDER BY count DESC, rank ASC
            """
        ).fetchall()

    print(f"taxa={total_taxa}")

    for row in rows:
        print(f"state.{row['state']}={row['count']}")

    for row in rank_rows:
        print(f"rank.{row['rank']}={row['count']}")

    return 0


def command_reset_icons(args: argparse.Namespace) -> int:
    database = Path(args.database)
    now = utc_now()

    with connect(database) as connection:
        migrate(connection)

        cursor = connection.execute(
            """
            UPDATE iconforge_icons
            SET
                state = 'pending',
                last_error = '',
                queued_at = ?,
                updated_at = ?
            """,
            (now, now),
        )
        connection.commit()

    print(f"reset={cursor.rowcount}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Manage the Speciedex Icon Forge SQLite index and queue."
        )
    )
    parser.add_argument(
        "--database",
        default=DEFAULT_DB.as_posix(),
        help=f"SQLite database path (default: {DEFAULT_DB.as_posix()}).",
    )

    subparsers = parser.add_subparsers(
        dest="command",
        required=True,
    )

    init_parser = subparsers.add_parser(
        "init",
        help="Create or migrate the icon-generation schema.",
    )
    init_parser.set_defaults(func=command_init)

    import_parser = subparsers.add_parser(
        "import-jsonl",
        help="Import normalized or enriched taxonomy JSONL.",
    )
    import_parser.add_argument(
        "--input",
        required=True,
    )
    import_parser.add_argument(
        "--strict",
        action="store_true",
    )
    import_parser.add_argument(
        "--fail-fast",
        action="store_true",
    )
    import_parser.set_defaults(func=command_import_jsonl)

    queue_parser = subparsers.add_parser(
        "queue",
        help="Display queue and rank statistics.",
    )
    queue_parser.set_defaults(func=command_queue)

    reset_parser = subparsers.add_parser(
        "reset-icons",
        help="Mark every indexed taxon as pending.",
    )
    reset_parser.set_defaults(func=command_reset_icons)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
