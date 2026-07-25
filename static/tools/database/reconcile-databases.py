#!/usr/bin/env python3
"""
Reconcile imported Speciedex database records into canonical taxonomy JSONL.

Expected location:
    static/tools/database/reconcile-databases.py

The reconciler merges records from JSON, JSONL, NDJSON, CSV, gzip-compressed
sources, and SQLite shard files into a deterministic canonical stream. It
records duplicate collisions, field-level conflicts, rejected records, and a
summary report suitable for update pipelines and release verification.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
"""

from __future__ import annotations

import argparse
import json
import logging
import sqlite3
import sys
import time
from collections import Counter
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence

from common import (
    InputRecordError,
    atomic_write_json,
    canonical_record,
    clean_text,
    iter_records,
    sqlite_rows,
    stable_json,
    utc_now,
    validate_canonical_record,
    write_jsonl,
)


EXIT_SUCCESS = 0
EXIT_VALIDATION = 1
EXIT_RECONCILIATION = 2
EXIT_CONFLICTS = 3
EXIT_INTERRUPTED = 130

DEFAULT_OUTPUT = Path(
    "static/data/taxonomy/reconciled/database-reconciled.jsonl"
)
DEFAULT_CONFLICTS = Path(
    "static/data/taxonomy/reconciled/conflicts.jsonl"
)
DEFAULT_REJECTED = Path(
    "static/data/taxonomy/reconciled/rejected.jsonl"
)
DEFAULT_SUMMARY = Path(
    "static/data/taxonomy/reconciled/reconciliation-summary.json"
)

SUPPORTED_DATABASE_SUFFIXES = {
    ".sqlite",
    ".sqlite3",
    ".db",
}


class ReconciliationError(RuntimeError):
    def __init__(self, message: str, exit_code: int = EXIT_RECONCILIATION) -> None:
        super().__init__(message)
        self.exit_code = exit_code


@dataclass
class Candidate:
    record: dict[str, Any]
    input_index: int
    source_path: str
    source_position: int


@dataclass
class Conflict:
    speciedex_id: str
    conflict_type: str
    winner_source: str
    loser_source: str
    differing_fields: list[str]
    winner: dict[str, Any]
    loser: dict[str, Any]


def human_duration(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def is_sqlite_path(path: Path) -> bool:
    return path.suffix.casefold() in SUPPORTED_DATABASE_SUFFIXES


def discover_inputs(paths: Sequence[Path], recursive: bool) -> list[Path]:
    discovered: list[Path] = []

    for raw in paths:
        path = raw.resolve()

        if not path.exists():
            raise ReconciliationError(
                f"Input path does not exist: {path}",
                EXIT_VALIDATION,
            )

        if path.is_file():
            discovered.append(path)
            continue

        iterator = path.rglob("*") if recursive else path.glob("*")
        for child in sorted(iterator, key=lambda value: value.as_posix()):
            if not child.is_file():
                continue
            lower = child.name.casefold()
            if (
                is_sqlite_path(child)
                or lower.endswith(".json")
                or lower.endswith(".jsonl")
                or lower.endswith(".ndjson")
                or lower.endswith(".csv")
                or lower.endswith(".json.gz")
                or lower.endswith(".jsonl.gz")
                or lower.endswith(".ndjson.gz")
                or lower.endswith(".csv.gz")
            ):
                discovered.append(child.resolve())

    unique = sorted(set(discovered), key=lambda value: value.as_posix())
    if not unique:
        raise ReconciliationError(
            "No supported input files were discovered.",
            EXIT_VALIDATION,
        )
    return unique


def iter_source_records(path: Path) -> Iterator[Mapping[str, Any]]:
    if is_sqlite_path(path):
        try:
            yield from sqlite_rows(path)
        except sqlite3.Error as error:
            raise ReconciliationError(
                f"Unable to read SQLite input {path}: {error}"
            ) from error
        return

    yield from iter_records(path)


def record_quality(record: Mapping[str, Any]) -> tuple[int, int, int]:
    """
    Return a deterministic quality score.

    More populated canonical fields are preferred. Accepted records are
    preferred over unknown or synonym records. Longer source payloads are
    used only as a final completeness signal.
    """
    populated_fields = sum(
        1
        for key, value in record.items()
        if key not in {"payload_json", "record_hash"}
        and value not in (None, "", [], {})
    )

    status = clean_text(record.get("status")).casefold()
    status_score = {
        "accepted": 4,
        "valid": 4,
        "provisionally_accepted": 3,
        "synonym": 2,
        "doubtful": 1,
        "unknown": 0,
    }.get(status, 0)

    payload_size = len(clean_text(record.get("payload_json")))
    return populated_fields, status_score, payload_size


def candidate_sort_key(candidate: Candidate) -> tuple[Any, ...]:
    record = candidate.record
    return (
        clean_text(record.get("indexed_at")),
        record_quality(record),
        clean_text(record.get("provider")),
        clean_text(record.get("source_file")),
        -candidate.input_index,
        -candidate.source_position,
        clean_text(record.get("record_hash")),
    )


def differing_fields(
    left: Mapping[str, Any],
    right: Mapping[str, Any],
) -> list[str]:
    ignored = {"payload_json", "record_hash", "indexed_at", "source_file"}
    keys = sorted(set(left) | set(right))
    return [
        key
        for key in keys
        if key not in ignored and left.get(key) != right.get(key)
    ]


class DatabaseReconciler:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.logger = logging.getLogger("speciedex.database.reconcile")
        self.started = time.monotonic()
        self.inputs = discover_inputs(args.inputs, args.recursive)
        self.merged: dict[str, Candidate] = {}
        self.conflicts: list[Conflict] = []
        self.rejected: list[dict[str, Any]] = []
        self.input_records = 0
        self.duplicate_records = 0
        self.identical_duplicates = 0
        self.provider_counts: Counter[str] = Counter()
        self.input_counts: Counter[str] = Counter()

    def configure_logging(self) -> None:
        level = logging.DEBUG if self.args.verbose else logging.INFO
        if self.args.quiet:
            level = logging.WARNING

        logging.basicConfig(
            level=level,
            format="%(asctime)s %(levelname)s %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )

    def normalize_candidate(
        self,
        raw: Mapping[str, Any],
        *,
        path: Path,
        input_index: int,
        source_position: int,
    ) -> Candidate | None:
        try:
            record = canonical_record(
                raw,
                source_file=path.as_posix(),
                provider_hint=path.stem,
            )
        except Exception as error:
            if self.args.strict:
                raise ReconciliationError(
                    f"{path}:{source_position}: normalization failed: {error}"
                ) from error

            self.rejected.append(
                {
                    "source_file": path.as_posix(),
                    "source_position": source_position,
                    "reason": f"normalization-error: {error}",
                    "raw": raw,
                }
            )
            return None

        errors = validate_canonical_record(record)
        if errors:
            if self.args.strict:
                raise ReconciliationError(
                    f"{path}:{source_position}: {'; '.join(errors)}"
                )

            self.rejected.append(
                {
                    "source_file": path.as_posix(),
                    "source_position": source_position,
                    "reason": "; ".join(errors),
                    "record": record,
                }
            )
            return None

        return Candidate(
            record=record,
            input_index=input_index,
            source_path=path.as_posix(),
            source_position=source_position,
        )

    def choose_winner(
        self,
        existing: Candidate,
        incoming: Candidate,
    ) -> tuple[Candidate, Candidate]:
        if self.args.prefer == "first":
            return existing, incoming
        if self.args.prefer == "last":
            return incoming, existing
        if self.args.prefer == "quality":
            if record_quality(incoming.record) > record_quality(existing.record):
                return incoming, existing
            if record_quality(incoming.record) < record_quality(existing.record):
                return existing, incoming

        if candidate_sort_key(incoming) >= candidate_sort_key(existing):
            return incoming, existing
        return existing, incoming

    def ingest(self) -> None:
        for input_index, path in enumerate(self.inputs):
            self.logger.info("Reading %s", path)

            try:
                iterator = iter_source_records(path)
                for source_position, raw in enumerate(iterator, 1):
                    self.input_records += 1
                    self.input_counts[path.as_posix()] += 1

                    candidate = self.normalize_candidate(
                        raw,
                        path=path,
                        input_index=input_index,
                        source_position=source_position,
                    )
                    if candidate is None:
                        continue

                    record = candidate.record
                    identifier = record["speciedex_id"]
                    provider = clean_text(record.get("provider")) or "unknown"
                    self.provider_counts[provider] += 1

                    existing = self.merged.get(identifier)
                    if existing is None:
                        self.merged[identifier] = candidate
                        continue

                    self.duplicate_records += 1

                    if existing.record["record_hash"] == record["record_hash"]:
                        self.identical_duplicates += 1
                        winner, _ = self.choose_winner(existing, candidate)
                        self.merged[identifier] = winner
                        continue

                    winner, loser = self.choose_winner(existing, candidate)
                    self.merged[identifier] = winner

                    self.conflicts.append(
                        Conflict(
                            speciedex_id=identifier,
                            conflict_type="record-hash-mismatch",
                            winner_source=winner.source_path,
                            loser_source=loser.source_path,
                            differing_fields=differing_fields(
                                winner.record,
                                loser.record,
                            ),
                            winner=winner.record,
                            loser=loser.record,
                        )
                    )

                    if (
                        self.args.progress_every
                        and self.input_records % self.args.progress_every == 0
                    ):
                        self.logger.info(
                            "Processed %d records; %d canonical records; "
                            "%d conflicts.",
                            self.input_records,
                            len(self.merged),
                            len(self.conflicts),
                        )

            except (OSError, InputRecordError, ReconciliationError) as error:
                if self.args.strict:
                    raise
                self.rejected.append(
                    {
                        "source_file": path.as_posix(),
                        "source_position": 0,
                        "reason": f"input-error: {error}",
                    }
                )
                self.logger.warning("Unable to fully process %s: %s", path, error)

    def sorted_records(self) -> Iterator[dict[str, Any]]:
        for identifier in sorted(self.merged):
            yield self.merged[identifier].record

    def write_outputs(self) -> None:
        if self.args.dry_run:
            self.logger.info(
                "Dry run: would write %d records, %d conflicts, and %d rejected records.",
                len(self.merged),
                len(self.conflicts),
                len(self.rejected),
            )
            return

        write_jsonl(
            self.args.output,
            self.sorted_records(),
            gzip_output=self.args.output.name.casefold().endswith(".gz"),
        )
        write_jsonl(
            self.args.conflicts,
            (asdict(conflict) for conflict in self.conflicts),
            gzip_output=self.args.conflicts.name.casefold().endswith(".gz"),
        )
        write_jsonl(
            self.args.rejected,
            self.rejected,
            gzip_output=self.args.rejected.name.casefold().endswith(".gz"),
        )

        elapsed = time.monotonic() - self.started
        summary = {
            "schema_version": 1,
            "generated_at": utc_now(),
            "duration_seconds": round(elapsed, 6),
            "duration": human_duration(elapsed),
            "inputs": [path.as_posix() for path in self.inputs],
            "output": self.args.output.as_posix(),
            "conflicts_output": self.args.conflicts.as_posix(),
            "rejected_output": self.args.rejected.as_posix(),
            "selection_policy": self.args.prefer,
            "strict": self.args.strict,
            "totals": {
                "input_records": self.input_records,
                "canonical_records": len(self.merged),
                "duplicate_records": self.duplicate_records,
                "identical_duplicates": self.identical_duplicates,
                "conflicts": len(self.conflicts),
                "rejected": len(self.rejected),
            },
            "providers": dict(sorted(self.provider_counts.items())),
            "input_counts": dict(sorted(self.input_counts.items())),
            "complete": not self.rejected,
            "conflict_free": not self.conflicts,
        }
        atomic_write_json(self.args.summary, summary)

    def verify_outputs(self) -> None:
        if self.args.dry_run or not self.args.verify:
            return

        expected = len(self.merged)
        actual = sum(1 for _ in iter_records(self.args.output))
        if actual != expected:
            raise ReconciliationError(
                f"Output count mismatch: expected {expected}, found {actual}"
            )

        actual_conflicts = sum(1 for _ in iter_records(self.args.conflicts))
        if actual_conflicts != len(self.conflicts):
            raise ReconciliationError(
                "Conflict output count mismatch."
            )

        actual_rejected = sum(1 for _ in iter_records(self.args.rejected))
        if actual_rejected != len(self.rejected):
            raise ReconciliationError(
                "Rejected output count mismatch."
            )

        summary = json.loads(self.args.summary.read_text(encoding="utf-8"))
        if not isinstance(summary, dict):
            raise ReconciliationError("Summary output is not a JSON object.")

    def run(self) -> int:
        self.configure_logging()

        try:
            self.ingest()
            self.write_outputs()
            self.verify_outputs()

            if self.args.fail_on_conflict and self.conflicts:
                raise ReconciliationError(
                    f"Reconciliation completed with {len(self.conflicts)} conflicts.",
                    EXIT_CONFLICTS,
                )

            if self.args.fail_on_rejected and self.rejected:
                raise ReconciliationError(
                    f"Reconciliation rejected {len(self.rejected)} records.",
                    EXIT_RECONCILIATION,
                )

        except KeyboardInterrupt:
            self.logger.error("Reconciliation interrupted.")
            return EXIT_INTERRUPTED
        except ReconciliationError as error:
            self.logger.error("%s", error)
            return error.exit_code
        except Exception as error:
            self.logger.error("Reconciliation failed: %s", error)
            if self.args.verbose:
                self.logger.exception("Detailed failure")
            return EXIT_RECONCILIATION

        self.logger.info(
            "Reconciled %d canonical records from %d input records with "
            "%d conflicts and %d rejected records in %s.",
            len(self.merged),
            self.input_records,
            len(self.conflicts),
            len(self.rejected),
            human_duration(time.monotonic() - self.started),
        )
        return EXIT_SUCCESS


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Reconcile imported database records into deterministic canonical "
            "Speciedex taxonomy JSONL."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument(
        "inputs",
        nargs="+",
        type=Path,
        help="Input files or directories to reconcile.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="Canonical reconciled JSONL output.",
    )
    parser.add_argument(
        "--conflicts",
        type=Path,
        default=DEFAULT_CONFLICTS,
        help="JSONL conflict report.",
    )
    parser.add_argument(
        "--rejected",
        type=Path,
        default=DEFAULT_REJECTED,
        help="JSONL rejected-record report.",
    )
    parser.add_argument(
        "--summary",
        type=Path,
        default=DEFAULT_SUMMARY,
        help="JSON reconciliation summary.",
    )
    parser.add_argument(
        "--prefer",
        choices=("latest", "quality", "first", "last"),
        default="latest",
        help="Winner selection policy for conflicting records.",
    )
    parser.add_argument(
        "--recursive",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Recursively discover supported files inside input directories.",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Fail immediately on invalid input or canonical records.",
    )
    parser.add_argument(
        "--fail-on-conflict",
        action="store_true",
        help="Return a nonzero exit code when conflicts are detected.",
    )
    parser.add_argument(
        "--fail-on-rejected",
        action="store_true",
        help="Return a nonzero exit code when records are rejected.",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Re-read generated outputs and verify record counts.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Reconcile in memory without writing output files.",
    )
    parser.add_argument(
        "--progress-every",
        type=int,
        default=100_000,
        help="Emit progress after this many input records; use 0 to disable.",
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

    return args


def main(argv: Sequence[str] | None = None) -> int:
    return DatabaseReconciler(parse_args(argv)).run()


if __name__ == "__main__":
    raise SystemExit(main())
