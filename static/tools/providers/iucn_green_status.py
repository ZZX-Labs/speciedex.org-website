#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/iucn_green_status.py

IUCN Green Status of Species provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It does not assume access to an undocumented or
unlicensed public API.

Each source object is normalized into a Taxon record while preserving the full
Green Status assessment under ``Taxon.extra["raw"]``. Green Status metrics are
kept separate from Red List threat categories because they represent recovery,
conservation impact, and future recovery potential rather than extinction risk.

Required provider configuration:

    {
        "name": "iucn_green_status",
        "path": "static/data/providers/iucn/green-status.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "IUCN Green Status of Species",
        "source_url": "https://www.iucnredlist.org/assessment/green-status"
    }

Copyright (c) 2026 ZZX-Laboratories
Licensed under the MIT License.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

from .common import (
    BaseProvider,
    Batch,
    ProviderError,
    Taxon,
    normalize_space,
    now,
    safe_int,
)


class Provider(BaseProvider):
    """File-backed IUCN Green Status of Species provider."""

    PROVIDER_NAME = "iucn_green_status"

    DEFAULT_SOURCE_NAME = "IUCN Green Status of Species"
    DEFAULT_SOURCE_URL = (
        "https://www.iucnredlist.org/assessment/green-status"
    )

    def fetch(self) -> Batch:
        """Read and normalize one resumable Green Status JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"IUCN Green Status export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"IUCN Green Status path is not a file: {source_path}"
            )

        offset = self._decode_cursor(
            self.cursor
        )

        configured_page_size = safe_int(
            self.definition.get(
                "page_size",
                self.batch_size,
            ),
            self.batch_size,
        )

        page_size = max(
            1,
            min(
                configured_page_size,
                self.batch_size,
            ),
        )

        records: list[Taxon] = []
        raw_count = 0
        next_offset = offset
        exhausted = True
        retrieved_at = now()

        with source_path.open(
            "r",
            encoding="utf-8",
        ) as handle:
            for line_number, line in enumerate(
                handle
            ):
                if line_number < offset:
                    continue

                if raw_count >= page_size:
                    exhausted = False
                    break

                next_offset = line_number + 1
                raw_count += 1

                stripped = line.strip()

                if not stripped:
                    continue

                try:
                    value = json.loads(
                        stripped
                    )
                except json.JSONDecodeError:
                    continue

                if not isinstance(
                    value,
                    Mapping,
                ):
                    continue

                record = self._normalize_record(
                    dict(value),
                    source_path=source_path,
                    retrieved_at=retrieved_at,
                )

                if record is not None:
                    records.append(
                        record
                    )

        return Batch(
            records=records,
            next_cursor=(
                None
                if exhausted
                else str(
                    next_offset
                )
            ),
            exhausted=exhausted,
            requests=0,
            raw=raw_count,
        )

    def _source_path(
        self,
    ) -> Path:
        """Resolve the configured JSONL source path."""

        configured = normalize_space(
            self.definition.get(
                "path"
            )
        )

        if not configured:
            raise ProviderError(
                "IUCN Green Status provider requires a path."
            )

        path = Path(
            configured
        )

        if not path.is_absolute():
            path = (
                self.repo_root
                / path
            )

        return path

    def _normalize_record(
        self,
        raw: dict[str, Any],
        *,
        source_path: Path,
        retrieved_at: str,
    ) -> Taxon | None:
        """Normalize one Green Status assessment record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "assessment_id",
                "assessmentId",
                "assessmentID",
                "green_status_id",
                "greenStatusId",
                "taxon_id",
                "taxonId",
                "id",
            )
        )

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "taxon_name",
                "taxonName",
                "binomial",
                "name",
            )
        )

        if not provider_id or not scientific_name:
            return None

        canonical_name = normalize_space(
            self._first_value(
                raw,
                "canonical_name",
                "canonicalName",
                "taxon_name",
                "taxonName",
                "binomial",
            )
        ) or scientific_name

        rank = normalize_space(
            self._first_value(
                raw,
                "rank",
                "taxon_rank",
                "taxonRank",
            )
        ).casefold() or self._infer_rank(
            canonical_name
        )

        taxonomic_status = self._normalize_taxonomic_status(
            self._first_value(
                raw,
                "taxonomic_status",
                "taxonomicStatus",
                "status",
            )
        )

        accepted_provider_id = normalize_space(
            self._first_value(
                raw,
                "accepted_taxon_id",
                "acceptedTaxonId",
                "accepted_id",
                "acceptedId",
            )
        )

        if accepted_provider_id == provider_id:
            accepted_provider_id = ""

        source_url = normalize_space(
            self._first_value(
                raw,
                "url",
                "assessment_url",
                "assessmentUrl",
                "source_url",
                "sourceUrl",
            )
        ) or normalize_space(
            self.definition.get(
                "source_url",
                self.DEFAULT_SOURCE_URL,
            )
        )

        green_score = self._optional_float(
            self._first_value(
                raw,
                "green_score",
                "greenScore",
                "species_recovery_score",
                "speciesRecoveryScore",
                "recovery_score",
                "recoveryScore",
            )
        )

        recovery_category = self._normalize_recovery_category(
            self._first_value(
                raw,
                "recovery_category",
                "recoveryCategory",
                "green_status_category",
                "greenStatusCategory",
                "category",
            )
        )

        conservation_legacy = self._optional_float(
            self._first_value(
                raw,
                "conservation_legacy",
                "conservationLegacy",
                "legacy_score",
                "legacyScore",
            )
        )

        conservation_dependence = self._optional_float(
            self._first_value(
                raw,
                "conservation_dependence",
                "conservationDependence",
                "dependence_score",
                "dependenceScore",
            )
        )

        recovery_potential = self._optional_float(
            self._first_value(
                raw,
                "recovery_potential",
                "recoveryPotential",
                "potential_score",
                "potentialScore",
            )
        )

        current_functionality = self._optional_float(
            self._first_value(
                raw,
                "current_functionality",
                "currentFunctionality",
                "functionality_score",
                "functionalityScore",
            )
        )

        synonyms = self._extract_synonyms(
            raw,
            scientific_name=scientific_name,
            canonical_name=canonical_name,
        )

        return Taxon(
            provider=self.name,
            provider_id=provider_id,
            scientific_name=scientific_name,
            canonical_name=canonical_name,
            rank=rank,
            status=taxonomic_status,
            authorship=normalize_space(
                self._first_value(
                    raw,
                    "authority",
                    "authorship",
                    "scientific_name_authorship",
                    "scientificNameAuthorship",
                )
            ),
            kingdom=normalize_space(
                self._first_value(
                    raw,
                    "kingdom",
                )
            ),
            phylum=normalize_space(
                self._first_value(
                    raw,
                    "phylum",
                )
            ),
            class_name=normalize_space(
                self._first_value(
                    raw,
                    "class",
                    "class_name",
                    "className",
                )
            ),
            order=normalize_space(
                self._first_value(
                    raw,
                    "order",
                )
            ),
            family=normalize_space(
                self._first_value(
                    raw,
                    "family",
                )
            ),
            genus=normalize_space(
                self._first_value(
                    raw,
                    "genus",
                )
            ),
            accepted_provider_id=accepted_provider_id,
            source_url=source_url,
            source_modified=normalize_space(
                self._first_value(
                    raw,
                    "modified",
                    "last_modified",
                    "lastModified",
                    "assessment_date",
                    "assessmentDate",
                    "year_published",
                    "yearPublished",
                )
            ),
            retrieved_at=retrieved_at,
            synonyms=synonyms,
            extra={
                "source": normalize_space(
                    self.definition.get(
                        "source_name",
                        self.DEFAULT_SOURCE_NAME,
                    )
                ) or self.DEFAULT_SOURCE_NAME,
                "iucn_program": "green_status",
                "reference_only": True,
                "assessment_id": provider_id,
                "taxon_id": normalize_space(
                    self._first_value(
                        raw,
                        "taxon_id",
                        "taxonId",
                        "sis_taxon_id",
                        "sisTaxonId",
                    )
                ),
                "green_status": {
                    "green_score": green_score,
                    "recovery_category": recovery_category,
                    "conservation_legacy": conservation_legacy,
                    "conservation_dependence": conservation_dependence,
                    "recovery_potential": recovery_potential,
                    "current_functionality": current_functionality,
                },
                "assessment": {
                    "year": normalize_space(
                        self._first_value(
                            raw,
                            "assessment_year",
                            "assessmentYear",
                            "year_published",
                            "yearPublished",
                        )
                    ),
                    "date": normalize_space(
                        self._first_value(
                            raw,
                            "assessment_date",
                            "assessmentDate",
                        )
                    ),
                    "version": normalize_space(
                        self._first_value(
                            raw,
                            "assessment_version",
                            "assessmentVersion",
                        )
                    ),
                    "scope": normalize_space(
                        self._first_value(
                            raw,
                            "scope",
                            "assessment_scope",
                            "assessmentScope",
                        )
                    ),
                    "assessor": normalize_space(
                        self._first_value(
                            raw,
                            "assessor",
                            "assessors",
                            "assessment_team",
                            "assessmentTeam",
                        )
                    ),
                },
                "scenarios": {
                    "counterfactual_without_conservation": self._scenario_value(
                        self._first_value(
                            raw,
                            "counterfactual_without_conservation",
                            "counterfactualWithoutConservation",
                            "without_conservation",
                            "withoutConservation",
                        )
                    ),
                    "current_with_conservation": self._scenario_value(
                        self._first_value(
                            raw,
                            "current_with_conservation",
                            "currentWithConservation",
                            "with_conservation",
                            "withConservation",
                        )
                    ),
                    "future_with_conservation": self._scenario_value(
                        self._first_value(
                            raw,
                            "future_with_conservation",
                            "futureWithConservation",
                        )
                    ),
                    "future_without_conservation": self._scenario_value(
                        self._first_value(
                            raw,
                            "future_without_conservation",
                            "futureWithoutConservation",
                        )
                    ),
                },
                "spatial_units": self._list_value(
                    self._first_value(
                        raw,
                        "spatial_units",
                        "spatialUnits",
                        "indigenous_range_units",
                        "indigenousRangeUnits",
                    )
                ),
                "range": {
                    "indigenous_range": self._first_value(
                        raw,
                        "indigenous_range",
                        "indigenousRange",
                    ),
                    "current_range": self._first_value(
                        raw,
                        "current_range",
                        "currentRange",
                    ),
                    "historical_range": self._first_value(
                        raw,
                        "historical_range",
                        "historicalRange",
                    ),
                },
                "functional_state": self._first_value(
                    raw,
                    "functional_state",
                    "functionalState",
                    "functionality",
                ),
                "population_state": self._first_value(
                    raw,
                    "population_state",
                    "populationState",
                    "population",
                ),
                "conservation_actions": self._list_value(
                    self._first_value(
                        raw,
                        "conservation_actions",
                        "conservationActions",
                        "actions",
                    )
                ),
                "threats": self._list_value(
                    self._first_value(
                        raw,
                        "threats",
                        "threat",
                    )
                ),
                "evidence": self._list_value(
                    self._first_value(
                        raw,
                        "evidence",
                        "supporting_evidence",
                        "supportingEvidence",
                    )
                ),
                "references": self._list_value(
                    self._first_value(
                        raw,
                        "references",
                        "bibliography",
                    )
                ),
                "red_list_category": normalize_space(
                    self._first_value(
                        raw,
                        "red_list_category",
                        "redListCategory",
                    )
                ),
                "bulk_source": source_path.as_posix(),
                "raw": raw,
            },
        )

    @staticmethod
    def _decode_cursor(
        cursor: str | None,
    ) -> int:
        """Decode a non-negative line offset."""

        if not cursor:
            return 0

        try:
            offset = int(
                cursor
            )
        except (
            TypeError,
            ValueError,
        ) as error:
            raise ProviderError(
                f"Invalid IUCN Green Status cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "IUCN Green Status cursor must be non-negative."
            )

        return offset

    @staticmethod
    def _normalize_taxonomic_status(
        value: Any,
    ) -> str:
        """Normalize taxonomic status independently of Green Status metrics."""

        status = normalize_space(
            value
        ).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "valid",
            "synonym": "synonym",
            "unaccepted": "synonym",
            "reference": "reference",
        }

        return aliases.get(
            status,
            status or "reference",
        )

    @staticmethod
    def _normalize_recovery_category(
        value: Any,
    ) -> str:
        """Normalize common Green Status recovery category labels."""

        category = normalize_space(
            value
        ).casefold()

        aliases = {
            "fully recovered": "fully recovered",
            "largely recovered": "largely recovered",
            "moderately recovered": "moderately recovered",
            "slightly recovered": "slightly recovered",
            "critically depleted": "critically depleted",
            "indeterminate": "indeterminate",
            "not evaluated": "not evaluated",
            "full recovery": "fully recovered",
            "large recovery": "largely recovered",
            "moderate recovery": "moderately recovered",
            "slight recovery": "slightly recovered",
        }

        return aliases.get(
            category,
            category or "unknown",
        )

    @classmethod
    def _extract_synonyms(
        cls,
        raw: Mapping[str, Any],
        *,
        scientific_name: str,
        canonical_name: str,
    ) -> list[str]:
        """Extract and deduplicate synonym-like names."""

        candidates = cls._list_value(
            cls._first_value(
                raw,
                "synonyms",
                "synonym",
                "taxonomic_synonyms",
                "taxonomicSynonyms",
            )
        )

        excluded = {
            scientific_name.casefold(),
            canonical_name.casefold(),
        }

        result: list[str] = []
        seen: set[str] = set(
            excluded
        )

        for item in candidates:
            if isinstance(
                item,
                Mapping,
            ):
                normalized = normalize_space(
                    cls._first_value(
                        item,
                        "scientific_name",
                        "scientificName",
                        "name",
                    )
                )
            else:
                normalized = normalize_space(
                    item
                )

            key = normalized.casefold()

            if (
                not normalized
                or key in seen
            ):
                continue

            seen.add(
                key
            )
            result.append(
                normalized
            )

        return result

    @staticmethod
    def _scenario_value(
        value: Any,
    ) -> Any:
        """Preserve scenario objects while normalizing scalar scores."""

        if isinstance(
            value,
            Mapping,
        ):
            return dict(
                value
            )

        if isinstance(
            value,
            list,
        ):
            return value

        parsed = Provider._optional_float(
            value
        )

        if parsed is not None:
            return parsed

        normalized = normalize_space(
            value
        )

        return (
            normalized
            if normalized
            else None
        )

    @staticmethod
    def _infer_rank(
        scientific_name: str,
    ) -> str:
        words = normalize_space(
            scientific_name
        ).split()

        if len(words) == 2:
            return "species"

        if len(words) >= 3:
            return "subspecies"

        return "unknown"

    @staticmethod
    def _first_value(
        record: Mapping[str, Any],
        *keys: str,
    ) -> Any:
        for key in keys:
            value = record.get(
                key
            )

            if value not in (
                None,
                "",
                [],
                {},
            ):
                return value

        return None

    @staticmethod
    def _list_value(
        value: Any,
    ) -> list[Any]:
        if value is None:
            return []

        if isinstance(
            value,
            list,
        ):
            return value

        return [
            value
        ]

    @staticmethod
    def _optional_float(
        value: Any,
    ) -> float | None:
        if value in (
            None,
            "",
        ):
            return None

        try:
            return float(
                value
            )
        except (
            TypeError,
            ValueError,
        ):
            return None
