#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/reconciler.py

Taxonomic reconciliation engine.

This module compares normalized provider Taxon records against the canonical
Speciedex archive and determines whether each record should:

- match an existing canonical taxon,
- create a new canonical taxon,
- or be recorded as an unresolved conflict.

Reconciliation uses, in order:

1. exact provider/source identifier matches,
2. exact deterministic identity-key matches,
3. weighted canonical-name and lineage matching,
4. ambiguity detection,
5. creation when no sufficiently strong match exists.

Copyright (c) 2026 ZZX-Laboratories

Licensed under the MIT License.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Protocol, Sequence

from providers.common import Taxon

from .archive import Archive, normalize_key


DEFAULT_PROVIDER_WEIGHTS: dict[str, float] = {
    "catalogue_of_life": 1.00,
    "itis": 0.99,
    "worms": 0.99,
    "gbif": 0.98,
    "ncbi_taxonomy": 0.98,
    "world_flora_online": 0.97,
    "powo": 0.97,
    "ipni": 0.96,
    "index_fungorum": 0.96,
    "mycobank": 0.96,
    "irmng": 0.95,
    "fishbase": 0.95,
    "sealifebase": 0.95,
    "algaebase": 0.95,
    "zoobank": 0.94,
    "open_tree_of_life": 0.94,
    "lpsn": 0.94,
    "gtdb": 0.94,
    "silva": 0.93,
    "ictv": 0.93,
    "obis": 0.92,
    "bold": 0.91,
    "paleobiology": 0.91,
    "eol": 0.90,
    "ala": 0.90,
    "natureserve": 0.90,
    "iucn_red_list": 0.89,
    "iucn_green_status": 0.88,
    "iucn_green_list": 0.88,
    "species_plus": 0.88,
    "ebird": 0.87,
    "inaturalist": 0.86,
    "global_names": 0.86,
    "wikispecies": 0.84,
    "unite": 0.93,
}

DEFAULT_PROVIDER_WEIGHT = 0.85

DEFAULT_MATCH_THRESHOLD = 75
DEFAULT_CONFLICT_THRESHOLD = 50
DEFAULT_MINIMUM_NAME_SCORE = 35

DEFAULT_FIELD_WEIGHTS: dict[str, int] = {
    "canonical_name": 35,
    "scientific_name": 8,
    "authorship": 20,
    "rank": 10,
    "kingdom": 15,
    "phylum": 4,
    "class": 4,
    "order": 4,
    "family": 4,
    "genus": 4,
    "accepted_provider_id": 4,
}

MAX_LINEAGE_SCORE = 20

ACTION_MATCH = "match"
ACTION_CREATE = "create"
ACTION_CONFLICT = "conflict"

VALID_RECONCILIATION_ACTIONS = {
    ACTION_MATCH,
    ACTION_CREATE,
    ACTION_CONFLICT,
}

SCORE_TOLERANCE = 0.000001


@dataclass(slots=True, frozen=True)
class ReconcilerConfiguration:
    """Immutable reconciler configuration snapshot."""

    match_threshold: float
    conflict_threshold: float
    minimum_name_score: int
    provider_weights: dict[str, float]
    field_weights: dict[str, int]

    def to_dict(self) -> dict[str, Any]:
        """Return JSON-compatible configuration data."""

        return {
            "match_threshold": self.match_threshold,
            "conflict_threshold": self.conflict_threshold,
            "minimum_name_score": self.minimum_name_score,
            "provider_weights": dict(
                self.provider_weights
            ),
            "field_weights": dict(
                self.field_weights
            ),
        }


class CandidateRow(Protocol):
    """Minimal protocol for SQLite reconciliation rows."""

    def __getitem__(
        self,
        key: str,
    ) -> Any:
        ...


@dataclass(slots=True)
class CandidateScore:
    """Detailed score for one canonical taxon candidate."""

    speciedex_id: str
    raw_score: int
    weighted_score: float
    provider_weight: float
    matched_fields: list[str] = field(
        default_factory=list
    )
    mismatched_fields: list[str] = field(
        default_factory=list
    )
    notes: list[str] = field(
        default_factory=list
    )

    def __post_init__(self) -> None:
        self.speciedex_id = str(
            self.speciedex_id
        ).strip()

        if not self.speciedex_id:
            raise ValueError(
                "Candidate score requires a speciedex_id."
            )

        self.raw_score = int(
            self.raw_score
        )
        self.weighted_score = float(
            self.weighted_score
        )
        self.provider_weight = float(
            self.provider_weight
        )

        if not math.isfinite(
            self.weighted_score
        ):
            raise ValueError(
                "Candidate weighted score must be finite."
            )

        if not math.isfinite(
            self.provider_weight
        ) or self.provider_weight <= 0:
            raise ValueError(
                "Candidate provider weight must be finite "
                "and positive."
            )

    @property
    def confidence(self) -> float:
        """Return score clamped to a percentage-like range."""

        return min(
            100.0,
            max(
                0.0,
                self.weighted_score,
            ),
        )

    def to_dict(
        self,
    ) -> dict[str, Any]:
        """Return a JSON-compatible score description."""

        return {
            "speciedex_id": self.speciedex_id,
            "raw_score": self.raw_score,
            "weighted_score": round(
                self.weighted_score,
                4,
            ),
            "provider_weight": self.provider_weight,
            "confidence": round(
                self.confidence,
                4,
            ),
            "matched_fields": list(
                self.matched_fields
            ),
            "mismatched_fields": list(
                self.mismatched_fields
            ),
            "notes": list(
                self.notes
            ),
        }


@dataclass(slots=True)
class ReconciliationResult:
    """Outcome of reconciling one provider Taxon."""

    action: str
    identifier: str | None
    candidates: list[str]
    reason: str
    score: float | None = None
    scored_candidates: list[
        CandidateScore
    ] = field(
        default_factory=list
    )

    def __post_init__(
        self,
    ) -> None:
        self.action = str(
            self.action
        ).strip().casefold()
        self.identifier = (
            None
            if self.identifier is None
            else str(
                self.identifier
            ).strip()
        )
        self.candidates = self._normalize_candidates(
            self.candidates
        )
        self.reason = " ".join(
            str(
                self.reason
            ).strip().split()
        )

        if self.action not in VALID_RECONCILIATION_ACTIONS:
            raise ValueError(
                "Unsupported reconciliation action: "
                f"{self.action}"
            )

        if (
            self.action == ACTION_MATCH
            and not self.identifier
        ):
            raise ValueError(
                "A match result requires an identifier."
            )

        if (
            self.action != ACTION_MATCH
            and self.identifier is not None
        ):
            raise ValueError(
                "Only match results may contain "
                "an identifier."
            )

        if self.score is not None:
            self.score = float(
                self.score
            )

            if not math.isfinite(
                self.score
            ):
                raise ValueError(
                    "Reconciliation score must be finite."
                )

        if (
            self.action == ACTION_MATCH
            and self.identifier not in self.candidates
        ):
            self.candidates.insert(
                0,
                self.identifier,
            )

        if (
            self.action == ACTION_CONFLICT
            and not self.candidates
        ):
            raise ValueError(
                "A conflict result requires candidates."
            )

    @staticmethod
    def _normalize_candidates(
        values: Iterable[Any],
    ) -> list[str]:
        """Normalize candidate identifiers deterministically."""

        return sorted(
            {
                str(
                    value
                ).strip()
                for value in values
                if str(
                    value
                ).strip()
            }
        )

    def as_legacy_tuple(
        self,
    ) -> tuple[
        str,
        str | None,
        list[str],
        str,
    ]:
        """
        Return the tuple shape used by the original stat-grabber.py.
        """

        return (
            self.action,
            self.identifier,
            list(
                self.candidates
            ),
            self.reason,
        )

    def to_dict(
        self,
    ) -> dict[str, Any]:
        """Return a JSON-compatible result."""

        return {
            "action": self.action,
            "identifier": self.identifier,
            "candidates": list(
                self.candidates
            ),
            "reason": self.reason,
            "score": self.score,
            "scored_candidates": [
                candidate.to_dict()
                for candidate
                in self.scored_candidates
            ],
        }


class Reconciler:
    """
    Reconcile normalized provider records against an Archive.

    The class is intentionally stateless apart from configuration. It never
    mutates the archive. The caller remains responsible for creating taxa,
    attaching assertions, or storing conflicts after receiving a result.
    """

    def __init__(
        self,
        *,
        provider_weights: Mapping[
            str,
            float,
        ] | None = None,
        field_weights: Mapping[
            str,
            int,
        ] | None = None,
        match_threshold: float = (
            DEFAULT_MATCH_THRESHOLD
        ),
        conflict_threshold: float = (
            DEFAULT_CONFLICT_THRESHOLD
        ),
        minimum_name_score: int = (
            DEFAULT_MINIMUM_NAME_SCORE
        ),
    ) -> None:
        match_threshold = self._finite_float(
            match_threshold,
            "match_threshold",
        )
        conflict_threshold = self._finite_float(
            conflict_threshold,
            "conflict_threshold",
        )

        if match_threshold <= 0:
            raise ValueError(
                "match_threshold must be positive."
            )

        if conflict_threshold < 0:
            raise ValueError(
                "conflict_threshold cannot be negative."
            )

        if conflict_threshold >= match_threshold:
            raise ValueError(
                "conflict_threshold must be below "
                "match_threshold."
            )

        if minimum_name_score < 0:
            raise ValueError(
                "minimum_name_score cannot be negative."
            )

        self.provider_weights = dict(
            DEFAULT_PROVIDER_WEIGHTS
        )

        if provider_weights:
            for provider, weight in (
                provider_weights.items()
            ):
                normalized_provider = normalize_key(
                    provider
                )

                if not normalized_provider:
                    continue

                parsed_weight = self._finite_float(
                    weight,
                    f"provider weight for {normalized_provider}",
                )

                if parsed_weight <= 0:
                    raise ValueError(
                        "Provider weights must be "
                        "positive."
                    )

                self.provider_weights[
                    normalized_provider
                ] = parsed_weight

        self.field_weights = dict(
            DEFAULT_FIELD_WEIGHTS
        )

        if field_weights:
            for field_name, weight in (
                field_weights.items()
            ):
                try:
                    parsed_weight = int(
                        weight
                    )
                except (
                    TypeError,
                    ValueError,
                ) as error:
                    raise ValueError(
                        "Field weights must be integers."
                    ) from error

                if parsed_weight < 0:
                    raise ValueError(
                        "Field weights cannot be "
                        "negative."
                    )

                normalized_field = str(
                    field_name
                ).strip()

                if not normalized_field:
                    raise ValueError(
                        "Field weight names cannot be empty."
                    )

                self.field_weights[
                    normalized_field
                ] = parsed_weight

        self.match_threshold = float(
            match_threshold
        )

        self.conflict_threshold = float(
            conflict_threshold
        )

        self.minimum_name_score = int(
            minimum_name_score
        )

    def configuration(
        self,
    ) -> ReconcilerConfiguration:
        """Return an immutable configuration snapshot."""

        return ReconcilerConfiguration(
            match_threshold=self.match_threshold,
            conflict_threshold=self.conflict_threshold,
            minimum_name_score=self.minimum_name_score,
            provider_weights=dict(
                self.provider_weights
            ),
            field_weights=dict(
                self.field_weights
            ),
        )

    def describe(
        self,
    ) -> dict[str, Any]:
        """Return compact reconciler diagnostics."""

        maximum_raw_score = (
            self._weight(
                "canonical_name"
            )
            + self._weight(
                "scientific_name"
            )
            + self._weight(
                "authorship"
            )
            + self._weight(
                "rank"
            )
            + self._weight(
                "kingdom"
            )
            + min(
                MAX_LINEAGE_SCORE,
                sum(
                    self._weight(
                        field_name
                    )
                    for field_name in (
                        "phylum",
                        "class",
                        "order",
                        "family",
                        "genus",
                    )
                ),
            )
            + self._weight(
                "accepted_provider_id"
            )
        )

        return {
            "match_threshold": self.match_threshold,
            "conflict_threshold": self.conflict_threshold,
            "minimum_name_score": self.minimum_name_score,
            "provider_weights": len(
                self.provider_weights
            ),
            "field_weights": len(
                self.field_weights
            ),
            "maximum_raw_score": maximum_raw_score,
        }

    def verify_configuration(
        self,
    ) -> dict[str, Any]:
        """Verify configuration consistency."""

        errors: list[str] = []
        warnings: list[str] = []

        if self.conflict_threshold >= self.match_threshold:
            errors.append(
                "conflict_threshold must be below match_threshold."
            )

        if self._weight(
            "canonical_name"
        ) <= 0:
            warnings.append(
                "canonical_name weight is not positive."
            )

        if self.minimum_name_score > self.describe()[
            "maximum_raw_score"
        ]:
            warnings.append(
                "minimum_name_score exceeds maximum raw score."
            )

        return {
            "valid": not errors,
            "errors": errors,
            "warnings": warnings,
        }

    def resolve(
        self,
        archive: Archive,
        record: Taxon,
    ) -> ReconciliationResult:
        """
        Determine whether a record matches, creates, or conflicts.

        Resolution precedence:

        1. existing provider/source identifier,
        2. exact identity key,
        3. weighted same-name candidates,
        4. create when no candidate is strong enough.
        """

        self._validate_record(
            record
        )

        direct = archive.source_match(
            record.provider,
            record.provider_id,
        )

        if direct:
            identifier = str(
                direct
            ).strip()

            if not identifier:
                raise ValueError(
                    "Archive returned an empty source match identifier."
                )

            return ReconciliationResult(
                action=ACTION_MATCH,
                identifier=identifier,
                candidates=[
                    identifier
                ],
                reason=(
                    "existing provider source identifier"
                ),
                score=100.0,
            )

        identity_key = archive.identity_key(
            record
        )

        exact_candidates = (
            archive.identity_candidates(
                identity_key
            )
        )

        if len(exact_candidates) == 1:
            identifier = self._candidate_identifier(
                exact_candidates[0]
            )

            return ReconciliationResult(
                action=ACTION_MATCH,
                identifier=identifier,
                candidates=[
                    identifier
                ],
                reason=(
                    "exact canonical identity key"
                ),
                score=100.0,
            )

        if len(exact_candidates) > 1:
            identifiers = self._unique_sorted(
                self._candidate_identifier(
                    row
                )
                for row in exact_candidates
            )

            return ReconciliationResult(
                action=ACTION_CONFLICT,
                identifier=None,
                candidates=identifiers,
                reason=(
                    "multiple canonical taxa share "
                    "the exact identity key"
                ),
                score=100.0,
            )

        rows = list(
            archive.name_candidates(
                record
            )
            or []
        )

        if not rows:
            return ReconciliationResult(
                action=ACTION_CREATE,
                identifier=None,
                candidates=[],
                reason=(
                    "no canonical taxon with the "
                    "same normalized name, rank, "
                    "and kingdom"
                ),
                score=None,
            )

        scored = [
            self.score_candidate(
                record,
                row,
            )
            for row in rows
        ]

        scored.sort(
            key=lambda candidate: (
                -candidate.weighted_score,
                -candidate.raw_score,
                candidate.speciedex_id,
            )
        )

        best_score = (
            scored[0].weighted_score
        )

        tied_best = [
            candidate
            for candidate in scored
            if self._scores_equal(
                candidate.weighted_score,
                best_score,
            )
        ]

        all_candidate_ids = self._unique_sorted(
            candidate.speciedex_id
            for candidate in scored
        )

        if (
            best_score
            >= self.match_threshold
            and len(tied_best) == 1
        ):
            best = tied_best[0]

            return ReconciliationResult(
                action=ACTION_MATCH,
                identifier=(
                    best.speciedex_id
                ),
                candidates=all_candidate_ids,
                reason=(
                    "unique high-confidence weighted "
                    "taxonomy match"
                ),
                score=best_score,
                scored_candidates=scored,
            )

        if (
            best_score
            >= self.conflict_threshold
        ):
            conflict_ids = [
                candidate.speciedex_id
                for candidate in tied_best
            ]

            if len(conflict_ids) == 1:
                conflict_ids = all_candidate_ids

            return ReconciliationResult(
                action=ACTION_CONFLICT,
                identifier=None,
                candidates=self._unique_sorted(
                    conflict_ids
                ),
                reason=(
                    "candidate confidence is "
                    "significant but not uniquely "
                    "high enough to merge"
                ),
                score=best_score,
                scored_candidates=scored,
            )

        return ReconciliationResult(
            action=ACTION_CREATE,
            identifier=None,
            candidates=all_candidate_ids,
            reason=(
                "all candidate scores are below "
                "the reconciliation threshold"
            ),
            score=best_score,
            scored_candidates=scored,
        )

    def resolve_many(
        self,
        archive: Archive,
        records: Iterable[Taxon],
    ) -> list[ReconciliationResult]:
        """Resolve records sequentially with stable ordering."""

        return [
            self.resolve(
                archive,
                record,
            )
            for record in records
        ]

    def score_candidate(
        self,
        record: Taxon,
        row: CandidateRow,
    ) -> CandidateScore:
        """
        Score one canonical candidate against a provider record.

        The raw taxonomic score is multiplied by the configured confidence
        weight for the incoming provider. Exact source-identifier and identity
        matches are resolved before this function is called.
        """

        matched_fields: list[str] = []
        mismatched_fields: list[str] = []
        notes: list[str] = []

        raw_score = 0
        name_score = 0

        canonical_match = self._same(
            record.canonical_name,
            row["canonical_name"],
        )

        if canonical_match:
            canonical_weight = self._weight(
                "canonical_name"
            )
            raw_score += canonical_weight
            name_score += canonical_weight
            matched_fields.append(
                "canonical_name"
            )
        else:
            mismatched_fields.append(
                "canonical_name"
            )

        scientific_name = self._row_value(
            row,
            "scientific_name",
        )

        if (
            record.scientific_name
            and scientific_name
        ):
            if self._same(
                record.scientific_name,
                scientific_name,
            ):
                scientific_weight = self._weight(
                    "scientific_name"
                )
                raw_score += scientific_weight
                name_score += scientific_weight
                matched_fields.append(
                    "scientific_name"
                )
            else:
                mismatched_fields.append(
                    "scientific_name"
                )

        authorship_match = self._optional_match(
            record.authorship,
            self._row_value(
                row,
                "authorship",
            ),
        )

        if authorship_match is True:
            raw_score += self._weight(
                "authorship"
            )
            matched_fields.append(
                "authorship"
            )
        elif authorship_match is False:
            mismatched_fields.append(
                "authorship"
            )

        rank_match = self._same(
            record.rank,
            self._row_value(
                row,
                "rank",
            ),
        )

        if rank_match:
            raw_score += self._weight(
                "rank"
            )
            matched_fields.append(
                "rank"
            )
        else:
            mismatched_fields.append(
                "rank"
            )

        kingdom_match = self._optional_match(
            record.kingdom,
            self._row_value(
                row,
                "kingdom",
            ),
        )

        if kingdom_match is True:
            raw_score += self._weight(
                "kingdom"
            )
            matched_fields.append(
                "kingdom"
            )
        elif kingdom_match is False:
            mismatched_fields.append(
                "kingdom"
            )

        lineage_score = 0

        lineage_fields = (
            (
                "phylum",
                record.phylum,
                "phylum",
            ),
            (
                "class",
                record.class_name,
                "class_name",
            ),
            (
                "order",
                record.order,
                "order_name",
            ),
            (
                "family",
                record.family,
                "family",
            ),
            (
                "genus",
                record.genus,
                "genus",
            ),
        )

        for (
            logical_name,
            record_value,
            row_column,
        ) in lineage_fields:
            candidate_value = (
                self._row_value(
                    row,
                    row_column,
                )
            )

            comparison = (
                self._optional_match(
                    record_value,
                    candidate_value,
                )
            )

            if comparison is True:
                contribution = self._weight(
                    logical_name
                )

                remaining = (
                    MAX_LINEAGE_SCORE
                    - lineage_score
                )

                awarded = min(
                    contribution,
                    remaining,
                )

                lineage_score += awarded

                matched_fields.append(
                    logical_name
                )

            elif comparison is False:
                mismatched_fields.append(
                    logical_name
                )

            if (
                lineage_score
                >= MAX_LINEAGE_SCORE
            ):
                break

        raw_score += lineage_score

        accepted_provider_id = normalize_key(
            getattr(
                record,
                "accepted_provider_id",
                "",
            )
        )

        if accepted_provider_id:
            notes.append(
                "incoming record references an "
                "accepted provider identifier"
            )

            raw_score += self._weight(
                "accepted_provider_id"
            )

            matched_fields.append(
                "accepted_provider_id_present"
            )

        provider_weight = (
            self.provider_weight(
                record.provider
            )
        )

        weighted_score = (
            float(raw_score)
            * provider_weight
        )

        if (
            name_score
            < self.minimum_name_score
        ):
            weighted_score = min(
                weighted_score,
                float(
                    self.conflict_threshold
                    - 0.0001
                ),
            )

            notes.append(
                "score capped because canonical "
                "name evidence is insufficient"
            )

        notes.append(
            f"name_score={name_score}"
        )

        identifier = self._candidate_identifier(
            row
        )

        return CandidateScore(
            speciedex_id=identifier,
            raw_score=raw_score,
            weighted_score=weighted_score,
            provider_weight=provider_weight,
            matched_fields=matched_fields,
            mismatched_fields=mismatched_fields,
            notes=notes,
        )

    def provider_weight(
        self,
        provider: str,
    ) -> float:
        """Return the configured confidence weight for a provider."""

        normalized = normalize_key(
            provider
        )

        return float(
            self.provider_weights.get(
                normalized,
                DEFAULT_PROVIDER_WEIGHT,
            )
        )

    def _weight(
        self,
        field_name: str,
    ) -> int:
        """Return a configured scoring weight."""

        return int(
            self.field_weights.get(
                field_name,
                0,
            )
        )

    @staticmethod
    def _validate_record(
        record: Taxon,
    ) -> None:
        """Reject records that cannot be reconciled safely."""

        if not isinstance(
            record,
            Taxon,
        ):
            raise TypeError(
                "record must be a Taxon object."
            )

        if not normalize_key(
            record.provider
        ):
            raise ValueError(
                "Taxon provider is required."
            )

        if not normalize_key(
            record.provider_id
        ):
            raise ValueError(
                "Taxon provider_id is required."
            )

        if not normalize_key(
            record.scientific_name
        ):
            raise ValueError(
                "Taxon scientific_name is required."
            )

        if not normalize_key(
            record.canonical_name
        ):
            raise ValueError(
                "Taxon canonical_name is required."
            )

        if not normalize_key(
            record.rank
        ):
            raise ValueError(
                "Taxon rank is required."
            )

    @staticmethod
    def _finite_float(
        value: Any,
        field_name: str,
    ) -> float:
        """Parse a finite float."""

        try:
            parsed = float(
                value
            )
        except (
            TypeError,
            ValueError,
        ) as error:
            raise ValueError(
                f"{field_name} must be numeric."
            ) from error

        if not math.isfinite(
            parsed
        ):
            raise ValueError(
                f"{field_name} must be finite."
            )

        return parsed

    @classmethod
    def _candidate_identifier(
        cls,
        row: CandidateRow,
    ) -> str:
        """Read and validate a candidate identifier."""

        identifier = str(
            cls._row_value(
                row,
                "speciedex_id",
            )
        ).strip()

        if not identifier:
            raise ValueError(
                "Candidate row has no speciedex_id."
            )

        return identifier

    @staticmethod
    def _same(
        left: Any,
        right: Any,
    ) -> bool:
        """Compare two normalized nonempty values."""

        left_key = normalize_key(
            left
        )

        right_key = normalize_key(
            right
        )

        return bool(
            left_key
            and right_key
            and left_key == right_key
        )

    @staticmethod
    def _optional_match(
        left: Any,
        right: Any,
    ) -> bool | None:
        """
        Compare optional values.

        None means one or both values were absent and therefore provide no
        positive or negative evidence.
        """

        left_key = normalize_key(
            left
        )

        right_key = normalize_key(
            right
        )

        if not left_key or not right_key:
            return None

        return left_key == right_key

    @staticmethod
    def _row_value(
        row: CandidateRow,
        key: str,
    ) -> Any:
        """Read a row column without depending on sqlite3.Row directly."""

        try:
            return row[key]
        except (
            KeyError,
            IndexError,
            TypeError,
        ):
            return ""

    @staticmethod
    def _scores_equal(
        left: float,
        right: float,
    ) -> bool:
        """Compare floating-point scores using a strict tolerance."""

        return math.isclose(
            left,
            right,
            rel_tol=0.0,
            abs_tol=SCORE_TOLERANCE,
        )

    @staticmethod
    def _unique_sorted(
        values: Iterable[str],
    ) -> list[str]:
        """Return deterministic unique identifiers."""

        return sorted(
            {
                str(
                    value
                ).strip()
                for value in values
                if str(
                    value
                ).strip()
            }
        )


def score_candidate(
    record: Taxon,
    row: CandidateRow,
    *,
    provider_weights: Mapping[
        str,
        float,
    ] | None = None,
    field_weights: Mapping[
        str,
        int,
    ] | None = None,
) -> int:
    """
    Compatibility wrapper for the original score_candidate function.

    Returns the rounded weighted candidate score as an integer.
    """

    reconciler = Reconciler(
        provider_weights=provider_weights,
        field_weights=field_weights,
    )

    result = reconciler.score_candidate(
        record,
        row,
    )

    return int(
        round(
            result.weighted_score
        )
    )


def resolve(
    archive: Archive,
    record: Taxon,
    *,
    provider_weights: Mapping[
        str,
        float,
    ] | None = None,
    field_weights: Mapping[
        str,
        int,
    ] | None = None,
    match_threshold: float = (
        DEFAULT_MATCH_THRESHOLD
    ),
    conflict_threshold: float = (
        DEFAULT_CONFLICT_THRESHOLD
    ),
) -> tuple[
    str,
    str | None,
    list[str],
    str,
]:
    """
    Compatibility wrapper for the original resolve function.

    It returns:

        action, identifier, candidates, reason
    """

    reconciler = Reconciler(
        provider_weights=provider_weights,
        field_weights=field_weights,
        match_threshold=match_threshold,
        conflict_threshold=conflict_threshold,
    )

    return reconciler.resolve(
        archive,
        record,
    ).as_legacy_tuple()

__all__ = [
    "ACTION_CONFLICT",
    "ACTION_CREATE",
    "ACTION_MATCH",
    "CandidateRow",
    "CandidateScore",
    "DEFAULT_CONFLICT_THRESHOLD",
    "DEFAULT_FIELD_WEIGHTS",
    "DEFAULT_MATCH_THRESHOLD",
    "DEFAULT_MINIMUM_NAME_SCORE",
    "DEFAULT_PROVIDER_WEIGHT",
    "DEFAULT_PROVIDER_WEIGHTS",
    "MAX_LINEAGE_SCORE",
    "Reconciler",
    "ReconcilerConfiguration",
    "ReconciliationResult",
    "SCORE_TOLERANCE",
    "VALID_RECONCILIATION_ACTIONS",
    "resolve",
    "score_candidate",
]
