#!/usr/bin/env python3
"""
Reconcile imported Speciedex database records into canonical taxonomy JSONL.

Expected location:
    static/tools/database/reconcile-databases.py

The reconciler merges imported JSON, JSONL, NDJSON, CSV, gzip-compressed
sources, and SQLite shard files into a deterministic canonical review stream.
It records duplicate collisions, field-level conflicts, rejected records, and
a structured reconciliation summary.

The canonical taxonomy archive remains authoritative. This command writes only
to the reconciliation area and does not overwrite archive volumes directly.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
"""

from __future__ import annotations

import argparse
import gzip
import json
import logging
import shutil
import sqlite3
import tempfile
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

from common import (
    InputRecordError,
    atomic_write_json,
    canonical_record,
    clean_text,
    iter_records,
    provider_hint_from_path,
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

SUPPORTED_DATABASE_SUFFIXES = {".sqlite", ".sqlite3", ".db"}
SUPPORTED_TEXT_SUFFIXES = (
    ".json",
    ".jsonl",
    ".ndjson",
    ".csv",
    ".json.gz",
    ".jsonl.gz",
    ".ndjson.gz",
    ".csv.gz",
)
IGNORED_NAMES = {
    "manifest.json",
    "checksums.json",
    "build-state.json",
    "build-summary.json",
    "reconciliation-summary.json",
}
IGNORED_PARTS = {
    "logs",
    "reports",
    "__pycache__",
    ".git",
}


class ReconciliationError(RuntimeError):
    def __init__(
        self,
        message: str,
        exit_code: int = EXIT_RECONCILIATION,
    ) -> None:
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
    winner_position: int
    loser_source: str
    loser_position: int
    differing_fields: list[str]
    winner_quality: tuple[int, int, int]
    loser_quality: tuple[int, int, int]
    winner: dict[str, Any]
    loser: dict[str, Any]


@dataclass
class InputResult:
    path: str
    records_read: int = 0
    records_accepted: int = 0
    records_rejected: int = 0
    duplicates: int = 0
    identical_duplicates: int = 0
    conflicts: int = 0
    issues: list[str] = field(default_factory=list)
    duration_seconds: float = 0.0


def human_duration(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def is_sqlite_path(path: Path) -> bool:
    return path.suffix.casefold() in SUPPORTED_DATABASE_SUFFIXES


def is_supported_path(path: Path) -> bool:
    lower = path.name.casefold()
    return is_sqlite_path(path) or lower.endswith(SUPPORTED_TEXT_SUFFIXES)


def should_ignore(path: Path) -> bool:
    if path.name.casefold() in IGNORED_NAMES:
        return True
    return any(part.casefold() in IGNORED_PARTS for part in path.parts)


def discover_inputs(
    paths: Sequence[Path],
    recursive: bool,
) -> list[Path]:
    discovered: list[Path] = []

    for raw in paths:
        path = raw.resolve()

        if not path.exists():
            raise ReconciliationError(
                f"Input path does not exist: {path}",
                EXIT_VALIDATION,
            )

        if path.is_file():
            if not is_supported_path(path):
                raise ReconciliationError(
                    f"Unsupported input file: {path}",
                    EXIT_VALIDATION,
                )
            discovered.append(path)
            continue

        iterator = path.rglob("*") if recursive else path.glob("*")
        for child in sorted(iterator, key=lambda item: item.as_posix()):
            if (
                child.is_file()
                and is_supported_path(child)
                and not should_ignore(child)
            ):
                discovered.append(child.resolve())

    unique = sorted(set(discovered), key=lambda item: item.as_posix())
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
    populated_fields = sum(
        1
        for key, value in record.items()
        if key not in {"payload_json", "record_hash"}
        and value not in (None, "", [], {})
    )

    status = clean_text(record.get("status")).casefold()
    status_score = {
        "accepted": 5,
        "valid": 5,
        "provisionally_accepted": 4,
        "synonym": 3,
        "doubtful": 2,
        "misapplied": 1,
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
        clean_text(record.get("record_hash")),
        -candidate.input_index,
        -candidate.source_position,
        stable_json(record),
    )


def differing_fields(
    left: Mapping[str, Any],
    right: Mapping[str, Any],
) -> list[str]:
    ignored = {
        "payload_json",
        "record_hash",
        "indexed_at",
        "source_file",
    }
    keys = sorted(set(left) | set(right))
    return [
        key
        for key in keys
        if key not in ignored and left.get(key) != right.get(key)
    ]


def count_jsonl(path: Path) -> int:
    opener = gzip.open if path.name.casefold().endswith(".gz") else open
    count = 0
    with opener(path, "rt", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                value = json.loads(stripped)
            except json.JSONDecodeError as error:
                raise ReconciliationError(
                    f"{path}:{line_number}: invalid JSON: {error}"
                ) from error
            if not isinstance(value, Mapping):
                raise ReconciliationError(
                    f"{path}:{line_number}: expected JSON object"
                )
            count += 1
    return count


class DatabaseReconciler:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.logger = logging.getLogger(
            "speciedex.database.reconcile"
        )
        self.started = time.monotonic()

        self.output = args.output.resolve()
        self.conflicts_path = args.conflicts.resolve()
        self.rejected_path = args.rejected.resolve()
        self.summary_path = args.summary.resolve()

        self.inputs = discover_inputs(args.inputs, args.recursive)
        self.merged: dict[str, Candidate] = {}
        self.conflicts: list[Conflict] = []
        self.rejected: list[dict[str, Any]] = []
        self.input_results: list[InputResult] = []

        self.input_records = 0
        self.duplicate_records = 0
        self.identical_duplicates = 0
        self.provider_counts: Counter[str] = Counter()
        self.input_counts: Counter[str] = Counter()
        self.issues: list[str] = []

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
        destinations = {
            self.output,
            self.conflicts_path,
            self.rejected_path,
            self.summary_path,
        }
        if len(destinations) != 4:
            raise ReconciliationError(
                "Output, conflicts, rejected, and summary paths must be distinct.",
                EXIT_VALIDATION,
            )

        for destination in destinations:
            destination.parent.mkdir(parents=True, exist_ok=True)
            probe: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    "w",
                    encoding="utf-8",
                    delete=False,
                    dir=destination.parent,
                    prefix=".speciedex-reconcile-write-test.",
                ) as handle:
                    handle.write("ok\n")
                    probe = Path(handle.name)
            except OSError as error:
                raise ReconciliationError(
                    f"Destination directory is not writable: "
                    f"{destination.parent}: {error}",
                    EXIT_VALIDATION,
                ) from error
            finally:
                if probe is not None:
                    probe.unlink(missing_ok=True)

        usage = shutil.disk_usage(self.output.parent)
        if usage.free < self.args.minimum_free_bytes:
            raise ReconciliationError(
                f"Insufficient free disk space: {usage.free} bytes available, "
                f"{self.args.minimum_free_bytes} required.",
                EXIT_VALIDATION,
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
                provider_hint=provider_hint_from_path(path),
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
                    "raw": dict(raw),
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
            record=dict(record),
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
            incoming_quality = record_quality(incoming.record)
            existing_quality = record_quality(existing.record)

            if incoming_quality > existing_quality:
                return incoming, existing
            if incoming_quality < existing_quality:
                return existing, incoming

        if candidate_sort_key(incoming) >= candidate_sort_key(existing):
            return incoming, existing
        return existing, incoming

    def ingest(self) -> None:
        for input_index, path in enumerate(self.inputs):
            started = time.monotonic()
            result = InputResult(path=path.as_posix())
            self.input_results.append(result)
            self.logger.info("Reading %s", path)

            try:
                iterator = iter_source_records(path)

                for source_position, raw in enumerate(iterator, 1):
                    self.input_records += 1
                    result.records_read += 1
                    self.input_counts[path.as_posix()] += 1

                    candidate = self.normalize_candidate(
                        raw,
                        path=path,
                        input_index=input_index,
                        source_position=source_position,
                    )
                    if candidate is None:
                        result.records_rejected += 1
                        continue

                    record = candidate.record
                    identifier = clean_text(record.get("speciedex_id"))
                    if not identifier:
                        result.records_rejected += 1
                        self.rejected.append(
                            {
                                "source_file": path.as_posix(),
                                "source_position": source_position,
                                "reason": "missing speciedex_id",
                                "record": record,
                            }
                        )
                        continue

                    provider = (
                        clean_text(record.get("provider")) or "unknown"
                    )
                    self.provider_counts[provider] += 1

                    existing = self.merged.get(identifier)
                    if existing is None:
                        self.merged[identifier] = candidate
                        result.records_accepted += 1
                        continue

                    self.duplicate_records += 1
                    result.duplicates += 1

                    if (
                        clean_text(existing.record.get("record_hash"))
                        and existing.record.get("record_hash")
                        == record.get("record_hash")
                    ):
                        self.identical_duplicates += 1
                        result.identical_duplicates += 1
                        winner, _ = self.choose_winner(existing, candidate)
                        self.merged[identifier] = winner
                        continue

                    if stable_json(existing.record) == stable_json(record):
                        self.identical_duplicates += 1
                        result.identical_duplicates += 1
                        continue

                    winner, loser = self.choose_winner(existing, candidate)
                    self.merged[identifier] = winner
                    fields = differing_fields(
                        winner.record,
                        loser.record,
                    )
                    self.conflicts.append(
                        Conflict(
                            speciedex_id=identifier,
                            conflict_type=(
                                "field-conflict"
                                if fields
                                else "record-hash-mismatch"
                            ),
                            winner_source=winner.source_path,
                            winner_position=winner.source_position,
                            loser_source=loser.source_path,
                            loser_position=loser.source_position,
                            differing_fields=fields,
                            winner_quality=record_quality(winner.record),
                            loser_quality=record_quality(loser.record),
                            winner=winner.record,
                            loser=loser.record,
                        )
                    )
                    result.conflicts += 1

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

            except (
                OSError,
                InputRecordError,
                ReconciliationError,
                sqlite3.Error,
            ) as error:
                message = f"input-error: {error}"
                result.issues.append(message)
                self.issues.append(f"{path}: {message}")

                if self.args.strict:
                    raise

                self.rejected.append(
                    {
                        "source_file": path.as_posix(),
                        "source_position": 0,
                        "reason": message,
                    }
                )
                result.records_rejected += 1
                self.logger.warning(
                    "Unable to fully process %s: %s",
                    path,
                    error,
                )

            finally:
                result.duration_seconds = round(
                    time.monotonic() - started,
                    6,
                )

        if (
            self.args.expect_records is not None
            and self.input_records != self.args.expect_records
        ):
            raise ReconciliationError(
                f"Input record count mismatch: "
                f"expected={self.args.expect_records}, "
                f"actual={self.input_records}",
                EXIT_VALIDATION,
            )

    def sorted_records(self) -> list[dict[str, Any]]:
        return [
            self.merged[identifier].record
            for identifier in sorted(self.merged)
        ]

    def build_summary(
        self,
        *,
        status: str,
        exit_code: int,
    ) -> dict[str, Any]:
        elapsed = time.monotonic() - self.started
        return {
            "schema_version": 3,
            "generated_at": utc_now(),
            "status": status,
            "exit_code": exit_code,
            "duration_seconds": round(elapsed, 6),
            "duration": human_duration(elapsed),
            "inputs": [path.as_posix() for path in self.inputs],
            "output": self.output.as_posix(),
            "conflicts_output": self.conflicts_path.as_posix(),
            "rejected_output": self.rejected_path.as_posix(),
            "selection_policy": self.args.prefer,
            "options": {
                "strict": self.args.strict,
                "recursive": self.args.recursive,
                "verify": self.args.verify,
                "fail_on_conflict": self.args.fail_on_conflict,
                "fail_on_rejected": self.args.fail_on_rejected,
                "dry_run": self.args.dry_run,
                "expect_records": self.args.expect_records,
            },
            "totals": {
                "input_files": len(self.inputs),
                "input_records": self.input_records,
                "canonical_records": len(self.merged),
                "duplicate_records": self.duplicate_records,
                "identical_duplicates": self.identical_duplicates,
                "conflicts": len(self.conflicts),
                "rejected": len(self.rejected),
                "issues": len(self.issues),
            },
            "providers": dict(sorted(self.provider_counts.items())),
            "input_counts": dict(sorted(self.input_counts.items())),
            "input_results": [asdict(result) for result in self.input_results],
            "issues": list(self.issues),
            "complete": not self.rejected and not self.issues,
            "conflict_free": not self.conflicts,
        }

    def write_outputs(
        self,
        records: Sequence[Mapping[str, Any]],
        exit_code: int,
    ) -> None:
        if self.args.dry_run:
            self.logger.info(
                "Dry run: would write %d records, %d conflicts, "
                "and %d rejected records.",
                len(records),
                len(self.conflicts),
                len(self.rejected),
            )
            return

        write_jsonl(
            self.output,
            records,
            gzip_output=self.output.name.casefold().endswith(".gz"),
        )
        write_jsonl(
            self.conflicts_path,
            (asdict(conflict) for conflict in self.conflicts),
            gzip_output=(
                self.conflicts_path.name.casefold().endswith(".gz")
            ),
        )
        write_jsonl(
            self.rejected_path,
            self.rejected,
            gzip_output=(
                self.rejected_path.name.casefold().endswith(".gz")
            ),
        )

        status = "success" if exit_code == EXIT_SUCCESS else "failed"
        atomic_write_json(
            self.summary_path,
            self.build_summary(
                status=status,
                exit_code=exit_code,
            ),
        )

    def verify_outputs(
        self,
        records: Sequence[Mapping[str, Any]],
    ) -> None:
        if self.args.dry_run or not self.args.verify:
            return

        actual = count_jsonl(self.output)
        if actual != len(records):
            raise ReconciliationError(
                f"Output count mismatch: "
                f"expected={len(records)}, actual={actual}"
            )

        actual_conflicts = count_jsonl(self.conflicts_path)
        if actual_conflicts != len(self.conflicts):
            raise ReconciliationError(
                "Conflict output count mismatch."
            )

        actual_rejected = count_jsonl(self.rejected_path)
        if actual_rejected != len(self.rejected):
            raise ReconciliationError(
                "Rejected output count mismatch."
            )

        try:
            summary = json.loads(
                self.summary_path.read_text(encoding="utf-8")
            )
        except json.JSONDecodeError as error:
            raise ReconciliationError(
                f"Summary output is invalid JSON: {error}"
            ) from error

        if not isinstance(summary, Mapping):
            raise ReconciliationError(
                "Summary output is not a JSON object."
            )

        totals = summary.get("totals")
        if not isinstance(totals, Mapping):
            raise ReconciliationError(
                "Summary totals are not a JSON object."
            )

        if int(totals.get("canonical_records", -1)) != len(records):
            raise ReconciliationError(
                "Summary canonical record count mismatch."
            )

    def run(self) -> int:
        self.configure_logging()
        records: list[dict[str, Any]] = []
        exit_code = EXIT_SUCCESS

        try:
            self.validate_environment()
            self.ingest()
            records = self.sorted_records()

            if self.args.fail_on_conflict and self.conflicts:
                exit_code = EXIT_CONFLICTS
            elif self.args.fail_on_rejected and self.rejected:
                exit_code = EXIT_RECONCILIATION

            self.write_outputs(records, exit_code)
            self.verify_outputs(records)

            if exit_code == EXIT_CONFLICTS:
                raise ReconciliationError(
                    f"Reconciliation completed with "
                    f"{len(self.conflicts)} conflicts.",
                    EXIT_CONFLICTS,
                )

            if exit_code == EXIT_RECONCILIATION:
                raise ReconciliationError(
                    f"Reconciliation rejected "
                    f"{len(self.rejected)} records.",
                    EXIT_RECONCILIATION,
                )

        except KeyboardInterrupt:
            self.logger.error("Reconciliation interrupted.")
            if not self.args.dry_run:
                try:
                    atomic_write_json(
                        self.summary_path,
                        self.build_summary(
                            status="interrupted",
                            exit_code=EXIT_INTERRUPTED,
                        ),
                    )
                except Exception:
                    pass
            return EXIT_INTERRUPTED

        except ReconciliationError as error:
            self.logger.error("%s", error)
            if not self.args.dry_run:
                try:
                    atomic_write_json(
                        self.summary_path,
                        self.build_summary(
                            status="failed",
                            exit_code=error.exit_code,
                        ),
                    )
                except Exception:
                    pass
            return error.exit_code

        except Exception as error:
            self.logger.error("Reconciliation failed: %s", error)
            if self.args.verbose:
                self.logger.exception("Detailed failure")
            if not self.args.dry_run:
                try:
                    self.issues.append(str(error))
                    atomic_write_json(
                        self.summary_path,
                        self.build_summary(
                            status="failed",
                            exit_code=EXIT_RECONCILIATION,
                        ),
                    )
                except Exception:
                    pass
            return EXIT_RECONCILIATION

        self.logger.info(
            "Reconciled %d canonical records from %d input records "
            "with %d conflicts and %d rejected records in %s.",
            len(records),
            self.input_records,
            len(self.conflicts),
            len(self.rejected),
            human_duration(time.monotonic() - self.started),
        )
        return EXIT_SUCCESS


def parse_args(
    argv: Sequence[str] | None = None,
) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Reconcile imported database records into a deterministic "
            "canonical Speciedex taxonomy review stream."
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
        default=False,
        help="Recursively discover supported files inside input directories.",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Fail immediately on invalid input or canonical records.",
    )
    parser.add_argument(
        "--expect-records",
        type=int,
        default=None,
        help="Expected total number of input records.",
    )
    parser.add_argument(
        "--minimum-free-bytes",
        type=int,
        default=64 * 1024 * 1024,
        help="Minimum free disk space required for output.",
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
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Re-read generated outputs and verify counts.",
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

    if args.expect_records is not None and args.expect_records < 0:
        parser.error("--expect-records cannot be negative.")

    if args.minimum_free_bytes < 0:
        parser.error("--minimum-free-bytes cannot be negative.")

    if args.progress_every < 0:
        parser.error("--progress-every cannot be negative.")

    if args.verbose and args.quiet:
        parser.error(
            "--verbose and --quiet cannot be used together."
        )

    return args


def main(argv: Sequence[str] | None = None) -> int:
    return DatabaseReconciler(parse_args(argv)).run()


if __name__ == "__main__":
    raise SystemExit(main())
