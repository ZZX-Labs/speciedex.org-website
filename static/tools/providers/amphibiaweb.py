#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/amphibiaweb.py

AmphibiaWeb provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It does not depend on a live or undocumented API during
the main ingestion workflow.

Each source record is normalized into the shared Speciedex Taxon contract while
the complete AmphibiaWeb object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "amphibiaweb",
        "path": "static/data/providers/amphibiaweb/species.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "AmphibiaWeb",
        "source_url": "https://amphibiaweb.org/"
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
    """File-backed AmphibiaWeb provider."""

    PROVIDER_NAME = "amphibiaweb"

    DEFAULT_SOURCE_NAME = "AmphibiaWeb"
    DEFAULT_SOURCE_URL = "https://amphibiaweb.org/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable AmphibiaWeb JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"AmphibiaWeb export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"AmphibiaWeb path is not a file: {source_path}"
            )

        offset = self._decode_cursor(self.cursor)

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
            logical_index = 0

            for physical_line, line in enumerate(
                handle,
                start=1,
            ):
                stripped = line.strip()

                if not stripped:
                    continue

                if stripped.startswith("#"):
                    continue

                if logical_index < offset:
                    logical_index += 1
                    continue

                if raw_count >= page_size:
                    exhausted = False
                    break

                next_offset = logical_index + 1
                logical_index += 1
                raw_count += 1

                try:
                    value = json.loads(stripped)
                except json.JSONDecodeError as error:
                    if bool(self.definition.get("strict", False)):
                        raise ProviderError(
                            f"Invalid AmphibiaWeb JSON at "
                            f"{source_path}:{physical_line}: {error}"
                        ) from error
                    continue

                if not isinstance(value, Mapping):
                    continue

                record = self._normalize_record(
                    dict(value),
                    source_path=source_path,
                    retrieved_at=retrieved_at,
                )

                if record is not None:
                    records.append(record)

        return Batch(
            records=records,
            next_cursor=None if exhausted else str(next_offset),
            exhausted=exhausted,
            requests=0,
            raw=raw_count,
        )

    def _source_path(self) -> Path:
        """Resolve the configured AmphibiaWeb JSONL source path."""

        configured = normalize_space(
            self.definition.get("path")
            or self.definition.get("file")
            or self.definition.get("source_path")
        )

        if not configured:
            raise ProviderError(
                "AmphibiaWeb provider requires a path."
            )

        path = Path(configured)

        if not path.is_absolute():
            path = self.repo_root / path

        return path

    def _normalize_record(
        self,
        raw: dict[str, Any],
        *,
        source_path: Path,
        retrieved_at: str,
    ) -> Taxon | None:
        """Normalize one AmphibiaWeb taxon record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "amphibiaweb_id",
                "amphibiawebId",
                "species_id",
                "speciesId",
                "taxon_id",
                "taxonId",
                "id",
            )
        )

        genus = normalize_space(
            self._first_value(
                raw,
                "genus",
                "genus_name",
                "genusName",
            )
        )

        species_epithet = normalize_space(
            self._first_value(
                raw,
                "species",
                "specific_epithet",
                "specificEpithet",
                "species_epithet",
                "speciesEpithet",
            )
        )

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "full_name",
                "fullName",
                "name",
            )
        )

        if not scientific_name and genus and species_epithet:
            scientific_name = f"{genus} {species_epithet}"

        if not provider_id or not scientific_name:
            return None

        canonical_name = normalize_space(
            self._first_value(
                raw,
                "canonical_name",
                "canonicalName",
                "name_without_authorship",
                "nameWithoutAuthorship",
            )
        ) or scientific_name

        rank = self._normalize_rank(
            self._first_value(
                raw,
                "rank",
                "taxon_rank",
                "taxonRank",
            )
        )

        if rank == "unknown":
            rank = self._infer_rank(canonical_name)

        status = self._normalize_status(
            self._first_value(
                raw,
                "status",
                "taxonomic_status",
                "taxonomicStatus",
                "name_status",
                "nameStatus",
            )
        )

        accepted_provider_id = normalize_space(
            self._first_value(
                raw,
                "accepted_species_id",
                "acceptedSpeciesId",
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
                "source_url",
                "sourceUrl",
                "record_url",
                "recordUrl",
                "species_url",
                "speciesUrl",
            )
        )

        if not source_url:
            source_url = (
                normalize_space(
                    self.definition.get(
                        "source_url",
                        self.DEFAULT_SOURCE_URL,
                    )
                ).rstrip("/")
                + "/cgi/amphib_query?where-genus="
                + genus
                + "&where-species="
                + species_epithet
            )

        lineage = self._extract_lineage(
            raw,
            genus=genus,
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
            status=status,
            authorship=normalize_space(
                self._first_value(
                    raw,
                    "authorship",
                    "scientific_name_authorship",
                    "scientificNameAuthorship",
                    "authority",
                    "author",
                )
            ),
            kingdom=lineage.get("kingdom", "Animalia"),
            phylum=lineage.get("phylum", "Chordata"),
            class_name=lineage.get("class", "Amphibia"),
            order=lineage.get("order", ""),
            family=lineage.get("family", ""),
            genus=lineage.get("genus", genus),
            accepted_provider_id=accepted_provider_id,
            source_url=source_url,
            source_modified=normalize_space(
                self._first_value(
                    raw,
                    "modified",
                    "last_modified",
                    "lastModified",
                    "updated",
                    "updated_at",
                    "updatedAt",
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
                "programme": "amphibiaweb",
                "reference_only": True,
                "amphibiaweb_id": provider_id,
                "accepted_species_id": accepted_provider_id,
                "lineage": lineage,
                "parent": {
                    "id": normalize_space(
                        self._first_value(
                            raw,
                            "parent_taxon_id",
                            "parentTaxonId",
                            "parent_id",
                            "parentId",
                        )
                    ),
                    "name": normalize_space(
                        self._first_value(
                            raw,
                            "parent_name",
                            "parentName",
                        )
                    ),
                    "rank": self._normalize_rank(
                        self._first_value(
                            raw,
                            "parent_rank",
                            "parentRank",
                        )
                    ),
                },
                "common_names": self._normalize_common_names(
                    self._first_value(
                        raw,
                        "common_names",
                        "commonNames",
                        "vernacular_names",
                        "vernacularNames",
                    ),
                    preferred=normalize_space(
                        self._first_value(
                            raw,
                            "common_name",
                            "commonName",
                            "english_name",
                            "englishName",
                        )
                    ),
                ),
                "distribution": {
                    "summary": self._first_value(
                        raw,
                        "distribution",
                        "geographic_distribution",
                        "geographicDistribution",
                        "range",
                    ),
                    "countries": self._normalize_regions(
                        self._first_value(
                            raw,
                            "countries",
                            "country",
                            "range_countries",
                            "rangeCountries",
                        )
                    ),
                    "states_provinces": self._normalize_regions(
                        self._first_value(
                            raw,
                            "states_provinces",
                            "statesProvinces",
                            "subnational_regions",
                            "subnationalRegions",
                        )
                    ),
                    "endemic": self._optional_bool(
                        self._first_value(
                            raw,
                            "endemic",
                            "is_endemic",
                            "isEndemic",
                        )
                    ),
                    "endemic_to": self._normalize_regions(
                        self._first_value(
                            raw,
                            "endemic_to",
                            "endemicTo",
                        )
                    ),
                    "elevation_min_m": self._optional_float(
                        self._first_value(
                            raw,
                            "elevation_min",
                            "elevationMin",
                            "minimum_elevation",
                            "minimumElevation",
                        )
                    ),
                    "elevation_max_m": self._optional_float(
                        self._first_value(
                            raw,
                            "elevation_max",
                            "elevationMax",
                            "maximum_elevation",
                            "maximumElevation",
                        )
                    ),
                },
                "habitat": {
                    "summary": normalize_space(
                        self._first_value(
                            raw,
                            "habitat",
                            "habitat_summary",
                            "habitatSummary",
                        )
                    ),
                    "habitats": self._list_value(
                        self._first_value(
                            raw,
                            "habitats",
                            "habitat_types",
                            "habitatTypes",
                        )
                    ),
                    "terrestrial": self._optional_bool(
                        self._first_value(
                            raw,
                            "terrestrial",
                            "is_terrestrial",
                            "isTerrestrial",
                        )
                    ),
                    "aquatic": self._optional_bool(
                        self._first_value(
                            raw,
                            "aquatic",
                            "is_aquatic",
                            "isAquatic",
                        )
                    ),
                    "arboreal": self._optional_bool(
                        self._first_value(
                            raw,
                            "arboreal",
                            "is_arboreal",
                            "isArboreal",
                        )
                    ),
                    "fossorial": self._optional_bool(
                        self._first_value(
                            raw,
                            "fossorial",
                            "is_fossorial",
                            "isFossorial",
                        )
                    ),
                    "stream_associated": self._optional_bool(
                        self._first_value(
                            raw,
                            "stream_associated",
                            "streamAssociated",
                        )
                    ),
                },
                "morphology": {
                    "description": normalize_space(
                        self._first_value(
                            raw,
                            "description",
                            "morphology",
                            "diagnosis",
                        )
                    ),
                    "snout_vent_length_min_mm": self._optional_float(
                        self._first_value(
                            raw,
                            "svl_min_mm",
                            "svlMinMm",
                            "snout_vent_length_min",
                            "snoutVentLengthMin",
                        )
                    ),
                    "snout_vent_length_max_mm": self._optional_float(
                        self._first_value(
                            raw,
                            "svl_max_mm",
                            "svlMaxMm",
                            "snout_vent_length_max",
                            "snoutVentLengthMax",
                        )
                    ),
                    "total_length_min_mm": self._optional_float(
                        self._first_value(
                            raw,
                            "total_length_min",
                            "totalLengthMin",
                        )
                    ),
                    "total_length_max_mm": self._optional_float(
                        self._first_value(
                            raw,
                            "total_length_max",
                            "totalLengthMax",
                        )
                    ),
                    "sexual_dimorphism": normalize_space(
                        self._first_value(
                            raw,
                            "sexual_dimorphism",
                            "sexualDimorphism",
                        )
                    ),
                    "coloration": normalize_space(
                        self._first_value(
                            raw,
                            "coloration",
                            "colouration",
                        )
                    ),
                },
                "life_history": {
                    "activity_pattern": normalize_space(
                        self._first_value(
                            raw,
                            "activity_pattern",
                            "activityPattern",
                        )
                    ),
                    "seasonality": normalize_space(
                        self._first_value(
                            raw,
                            "seasonality",
                        )
                    ),
                    "diet": self._list_value(
                        self._first_value(
                            raw,
                            "diet",
                            "food",
                            "prey",
                        )
                    ),
                    "longevity_years": self._optional_float(
                        self._first_value(
                            raw,
                            "longevity",
                            "longevity_years",
                            "longevityYears",
                        )
                    ),
                    "generation_length_years": self._optional_float(
                        self._first_value(
                            raw,
                            "generation_length",
                            "generationLength",
                        )
                    ),
                    "population_trend": normalize_space(
                        self._first_value(
                            raw,
                            "population_trend",
                            "populationTrend",
                        )
                    ),
                },
                "reproduction": {
                    "breeding": normalize_space(
                        self._first_value(
                            raw,
                            "breeding",
                            "breeding_biology",
                            "breedingBiology",
                        )
                    ),
                    "breeding_season": normalize_space(
                        self._first_value(
                            raw,
                            "breeding_season",
                            "breedingSeason",
                        )
                    ),
                    "breeding_habitat": self._list_value(
                        self._first_value(
                            raw,
                            "breeding_habitat",
                            "breedingHabitat",
                        )
                    ),
                    "reproductive_mode": normalize_space(
                        self._first_value(
                            raw,
                            "reproductive_mode",
                            "reproductiveMode",
                        )
                    ),
                    "egg_deposition": normalize_space(
                        self._first_value(
                            raw,
                            "egg_deposition",
                            "eggDeposition",
                        )
                    ),
                    "clutch_size_min": self._optional_int(
                        self._first_value(
                            raw,
                            "clutch_size_min",
                            "clutchSizeMin",
                        )
                    ),
                    "clutch_size_max": self._optional_int(
                        self._first_value(
                            raw,
                            "clutch_size_max",
                            "clutchSizeMax",
                        )
                    ),
                    "parental_care": normalize_space(
                        self._first_value(
                            raw,
                            "parental_care",
                            "parentalCare",
                        )
                    ),
                    "direct_development": self._optional_bool(
                        self._first_value(
                            raw,
                            "direct_development",
                            "directDevelopment",
                        )
                    ),
                },
                "larval_biology": {
                    "larval_type": normalize_space(
                        self._first_value(
                            raw,
                            "larval_type",
                            "larvalType",
                        )
                    ),
                    "tadpole_description": normalize_space(
                        self._first_value(
                            raw,
                            "tadpole_description",
                            "tadpoleDescription",
                            "larval_description",
                            "larvalDescription",
                        )
                    ),
                    "larval_habitat": self._list_value(
                        self._first_value(
                            raw,
                            "larval_habitat",
                            "larvalHabitat",
                        )
                    ),
                    "larval_duration_days": self._optional_float(
                        self._first_value(
                            raw,
                            "larval_duration_days",
                            "larvalDurationDays",
                        )
                    ),
                    "metamorphosis": normalize_space(
                        self._first_value(
                            raw,
                            "metamorphosis",
                            "metamorphosis_notes",
                            "metamorphosisNotes",
                        )
                    ),
                },
                "behavior": {
                    "summary": normalize_space(
                        self._first_value(
                            raw,
                            "behavior",
                            "behaviour",
                        )
                    ),
                    "call": normalize_space(
                        self._first_value(
                            raw,
                            "call",
                            "advertisement_call",
                            "advertisementCall",
                        )
                    ),
                    "defense": normalize_space(
                        self._first_value(
                            raw,
                            "defense",
                            "defensive_behavior",
                            "defensiveBehavior",
                        )
                    ),
                    "sociality": normalize_space(
                        self._first_value(
                            raw,
                            "sociality",
                            "social_behavior",
                            "socialBehavior",
                        )
                    ),
                },
                "conservation": {
                    "iucn_status": normalize_space(
                        self._first_value(
                            raw,
                            "iucn_status",
                            "iucnStatus",
                            "conservation_status",
                            "conservationStatus",
                        )
                    ),
                    "iucn_assessment_id": normalize_space(
                        self._first_value(
                            raw,
                            "iucn_assessment_id",
                            "iucnAssessmentId",
                        )
                    ),
                    "national_statuses": self._list_value(
                        self._first_value(
                            raw,
                            "national_statuses",
                            "nationalStatuses",
                        )
                    ),
                    "protected": self._optional_bool(
                        self._first_value(
                            raw,
                            "protected",
                            "is_protected",
                            "isProtected",
                        )
                    ),
                    "population_status": normalize_space(
                        self._first_value(
                            raw,
                            "population_status",
                            "populationStatus",
                        )
                    ),
                },
                "threats": self._normalize_threats(
                    self._first_value(
                        raw,
                        "threats",
                        "threat",
                    )
                ),
                "disease": {
                    "chytrid_detected": self._optional_bool(
                        self._first_value(
                            raw,
                            "chytrid_detected",
                            "chytridDetected",
                            "bd_detected",
                            "bdDetected",
                        )
                    ),
                    "batr_status": normalize_space(
                        self._first_value(
                            raw,
                            "batr_status",
                            "batrStatus",
                            "bd_status",
                            "bdStatus",
                        )
                    ),
                    "ranavirus_detected": self._optional_bool(
                        self._first_value(
                            raw,
                            "ranavirus_detected",
                            "ranavirusDetected",
                        )
                    ),
                    "diseases": self._list_value(
                        self._first_value(
                            raw,
                            "diseases",
                            "disease",
                        )
                    ),
                },
                "taxonomy": {
                    "original_combination": normalize_space(
                        self._first_value(
                            raw,
                            "original_combination",
                            "originalCombination",
                        )
                    ),
                    "type_locality": normalize_space(
                        self._first_value(
                            raw,
                            "type_locality",
                            "typeLocality",
                        )
                    ),
                    "type_specimen": normalize_space(
                        self._first_value(
                            raw,
                            "type_specimen",
                            "typeSpecimen",
                        )
                    ),
                    "taxonomic_notes": normalize_space(
                        self._first_value(
                            raw,
                            "taxonomic_notes",
                            "taxonomicNotes",
                        )
                    ),
                    "etymology": normalize_space(
                        self._first_value(
                            raw,
                            "etymology",
                        )
                    ),
                },
                "media": self._normalize_media(
                    self._first_value(
                        raw,
                        "media",
                        "images",
                        "image",
                        "audio",
                    )
                ),
                "identifiers": self._normalize_identifiers(
                    self._first_value(
                        raw,
                        "identifiers",
                        "external_identifiers",
                        "externalIdentifiers",
                    ),
                    raw=raw,
                ),
                "references": self._normalize_references(
                    self._first_value(
                        raw,
                        "references",
                        "reference",
                        "bibliography",
                    )
                ),
                "contributors": self._normalize_contributors(
                    self._first_value(
                        raw,
                        "contributors",
                        "authors",
                        "reviewers",
                    )
                ),
                "notes": self._list_value(
                    self._first_value(
                        raw,
                        "notes",
                        "remarks",
                        "comments",
                    )
                ),
                "bulk_source": source_path.as_posix(),
                "raw": raw,
            },
        )

    @classmethod
    def _extract_lineage(
        cls,
        raw: Mapping[str, Any],
        *,
        genus: str,
    ) -> dict[str, str]:
        """Extract amphibian classification from direct or nested fields."""

        lineage = {
            "kingdom": normalize_space(
                raw.get("kingdom")
            ) or "Animalia",
            "phylum": normalize_space(
                raw.get("phylum")
            ) or "Chordata",
            "class": normalize_space(
                raw.get("class")
            ) or "Amphibia",
            "order": normalize_space(raw.get("order")),
            "family": normalize_space(raw.get("family")),
            "subfamily": normalize_space(raw.get("subfamily")),
            "genus": genus or normalize_space(raw.get("genus")),
            "species": normalize_space(raw.get("species")),
        }

        lineage_value = cls._first_value(
            raw,
            "lineage",
            "classification",
            "higher_taxa",
            "higherTaxa",
        )

        for item in cls._list_value(lineage_value):
            if not isinstance(item, Mapping):
                continue

            rank = cls._normalize_rank(
                cls._first_value(
                    item,
                    "rank",
                    "taxon_rank",
                    "taxonRank",
                )
            )

            name = normalize_space(
                cls._first_value(
                    item,
                    "name",
                    "scientific_name",
                    "scientificName",
                )
            )

            if rank and name and not lineage.get(rank):
                lineage[rank] = name

        return lineage

    @classmethod
    def _extract_synonyms(
        cls,
        raw: Mapping[str, Any],
        *,
        scientific_name: str,
        canonical_name: str,
    ) -> list[str]:
        """Extract and deduplicate amphibian taxonomic synonyms."""

        values = cls._list_value(
            cls._first_value(
                raw,
                "synonyms",
                "synonym",
                "taxonomic_synonyms",
                "taxonomicSynonyms",
                "former_names",
                "formerNames",
                "alternative_names",
                "alternativeNames",
            )
        )

        excluded = {
            scientific_name.casefold(),
            canonical_name.casefold(),
        }

        result: list[str] = []
        seen: set[str] = set(excluded)

        for item in values:
            if isinstance(item, Mapping):
                normalized = normalize_space(
                    cls._first_value(
                        item,
                        "scientific_name",
                        "scientificName",
                        "name",
                    )
                )
            else:
                normalized = normalize_space(item)

            key = normalized.casefold()

            if not normalized or key in seen:
                continue

            seen.add(key)
            result.append(normalized)

        return result

    @classmethod
    def _normalize_common_names(
        cls,
        value: Any,
        *,
        preferred: str,
    ) -> list[dict[str, Any]]:
        """Normalize vernacular names with language and locality metadata."""

        values = cls._list_value(value)

        if preferred:
            values.insert(
                0,
                {
                    "name": preferred,
                    "preferred": True,
                },
            )

        result: list[dict[str, Any]] = []
        seen: set[tuple[str, str, str]] = set()

        for item in values:
            if isinstance(item, Mapping):
                name = normalize_space(
                    cls._first_value(
                        item,
                        "name",
                        "common_name",
                        "commonName",
                        "vernacular_name",
                        "vernacularName",
                    )
                )
                language = normalize_space(
                    cls._first_value(
                        item,
                        "language",
                        "lang",
                        "language_code",
                        "languageCode",
                    )
                )
                locality = normalize_space(
                    cls._first_value(
                        item,
                        "locality",
                        "country",
                        "region",
                    )
                )
                preferred_value = cls._optional_bool(
                    cls._first_value(
                        item,
                        "preferred",
                        "is_preferred",
                        "isPreferred",
                    )
                )
                raw_item = dict(item)
            else:
                name = normalize_space(item)
                language = ""
                locality = ""
                preferred_value = None
                raw_item = item

            key = (
                name.casefold(),
                language.casefold(),
                locality.casefold(),
            )

            if not name or key in seen:
                continue

            seen.add(key)
            result.append(
                {
                    "name": name,
                    "language": language,
                    "locality": locality,
                    "preferred": preferred_value,
                    "raw": raw_item,
                }
            )

        return result

    @classmethod
    def _normalize_regions(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize country, region, and locality records."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                entry = dict(item)
                entry.update(
                    {
                        "name": normalize_space(
                            cls._first_value(
                                item,
                                "name",
                                "country",
                                "region",
                                "area",
                            )
                        ),
                        "code": normalize_space(
                            cls._first_value(
                                item,
                                "code",
                                "country_code",
                                "countryCode",
                                "iso_code",
                                "isoCode",
                            )
                        ),
                        "status": normalize_space(
                            cls._first_value(
                                item,
                                "status",
                                "presence",
                                "occurrence_status",
                                "occurrenceStatus",
                            )
                        ),
                    }
                )

                if entry.get("name") or entry.get("code"):
                    result.append(entry)
            else:
                name = normalize_space(item)

                if name:
                    result.append(
                        {
                            "name": name,
                            "code": "",
                            "status": "",
                        }
                    )

        return result

    @classmethod
    def _normalize_threats(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize threat records."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                entry = dict(item)
                entry.update(
                    {
                        "name": normalize_space(
                            cls._first_value(
                                item,
                                "name",
                                "threat",
                                "title",
                            )
                        ),
                        "scope": normalize_space(
                            cls._first_value(
                                item,
                                "scope",
                            )
                        ),
                        "severity": normalize_space(
                            cls._first_value(
                                item,
                                "severity",
                            )
                        ),
                        "timing": normalize_space(
                            cls._first_value(
                                item,
                                "timing",
                            )
                        ),
                        "description": normalize_space(
                            cls._first_value(
                                item,
                                "description",
                                "notes",
                                "remarks",
                            )
                        ),
                    }
                )
                result.append(entry)
            else:
                name = normalize_space(item)

                if name:
                    result.append(
                        {
                            "name": name,
                            "scope": "",
                            "severity": "",
                            "timing": "",
                            "description": "",
                        }
                    )

        return result

    @classmethod
    def _normalize_media(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize image, audio, video, and map metadata."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                entry = dict(item)
                entry.update(
                    {
                        "url": normalize_space(
                            cls._first_value(
                                item,
                                "url",
                                "identifier",
                                "media_url",
                                "mediaUrl",
                                "image_url",
                                "imageUrl",
                                "audio_url",
                                "audioUrl",
                            )
                        ),
                        "type": normalize_space(
                            cls._first_value(
                                item,
                                "type",
                                "media_type",
                                "mediaType",
                            )
                        ).casefold(),
                        "title": normalize_space(
                            cls._first_value(
                                item,
                                "title",
                                "caption",
                                "description",
                            )
                        ),
                        "creator": normalize_space(
                            cls._first_value(
                                item,
                                "creator",
                                "author",
                                "photographer",
                                "recordist",
                            )
                        ),
                        "license": normalize_space(
                            cls._first_value(
                                item,
                                "license",
                                "rights",
                            )
                        ),
                    }
                )
            else:
                entry = {
                    "url": normalize_space(item),
                    "type": "",
                    "title": "",
                    "creator": "",
                    "license": "",
                }

            if entry.get("url"):
                result.append(entry)

        return result

    @classmethod
    def _normalize_identifiers(
        cls,
        value: Any,
        *,
        raw: Mapping[str, Any],
    ) -> list[dict[str, str]]:
        """Normalize AmphibiaWeb and external taxonomic identifiers."""

        result: list[dict[str, str]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                identifier = normalize_space(
                    cls._first_value(
                        item,
                        "identifier",
                        "id",
                        "value",
                    )
                )
                source = normalize_space(
                    cls._first_value(
                        item,
                        "source",
                        "database",
                        "namespace",
                    )
                )
            else:
                identifier = normalize_space(item)
                source = ""

            if identifier:
                result.append(
                    {
                        "identifier": identifier,
                        "source": source,
                    }
                )

        known_fields = {
            "gbif_id": "GBIF",
            "gbifId": "GBIF",
            "itis_tsn": "ITIS",
            "itisTsn": "ITIS",
            "iucn_id": "IUCN",
            "iucnId": "IUCN",
            "asw_id": "Amphibian Species of the World",
            "aswId": "Amphibian Species of the World",
            "wikidata_id": "Wikidata",
            "wikidataId": "Wikidata",
            "eol_id": "Encyclopedia of Life",
            "eolId": "Encyclopedia of Life",
        }

        seen = {
            (
                entry["source"].casefold(),
                entry["identifier"].casefold(),
            )
            for entry in result
        }

        for field, source in known_fields.items():
            identifier = normalize_space(raw.get(field))

            key = (
                source.casefold(),
                identifier.casefold(),
            )

            if not identifier or key in seen:
                continue

            seen.add(key)
            result.append(
                {
                    "identifier": identifier,
                    "source": source,
                }
            )

        return result

    @classmethod
    def _normalize_references(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize literature and AmphibiaWeb references."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                entry = dict(item)
                entry.update(
                    {
                        "citation": normalize_space(
                            cls._first_value(
                                item,
                                "citation",
                                "title",
                                "reference",
                            )
                        ),
                        "authors": normalize_space(
                            cls._first_value(
                                item,
                                "authors",
                                "author",
                            )
                        ),
                        "year": normalize_space(
                            cls._first_value(
                                item,
                                "year",
                                "publication_year",
                                "publicationYear",
                            )
                        ),
                        "doi": normalize_space(
                            cls._first_value(
                                item,
                                "doi",
                            )
                        ),
                        "url": normalize_space(
                            cls._first_value(
                                item,
                                "url",
                                "source_url",
                                "sourceUrl",
                            )
                        ),
                    }
                )
                result.append(entry)
            else:
                citation = normalize_space(item)

                if citation:
                    result.append(
                        {
                            "citation": citation,
                            "authors": "",
                            "year": "",
                            "doi": "",
                            "url": "",
                        }
                    )

        return result

    @classmethod
    def _normalize_contributors(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize account authors, reviewers, and contributors."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                entry = dict(item)
                entry.update(
                    {
                        "name": normalize_space(
                            cls._first_value(
                                item,
                                "name",
                                "full_name",
                                "fullName",
                            )
                        ),
                        "role": normalize_space(
                            cls._first_value(
                                item,
                                "role",
                                "contribution",
                            )
                        ),
                        "affiliation": normalize_space(
                            cls._first_value(
                                item,
                                "affiliation",
                                "organization",
                            )
                        ),
                        "orcid": normalize_space(
                            cls._first_value(
                                item,
                                "orcid",
                            )
                        ),
                    }
                )

                if entry.get("name"):
                    result.append(entry)
            else:
                name = normalize_space(item)

                if name:
                    result.append(
                        {
                            "name": name,
                            "role": "",
                            "affiliation": "",
                            "orcid": "",
                        }
                    )

        return result

    @staticmethod
    def _normalize_rank(value: Any) -> str:
        """Normalize amphibian taxonomic rank labels."""

        rank = normalize_space(value).casefold().replace(
            "_",
            " ",
        ).replace(
            "-",
            " ",
        )

        aliases = {
            "sub species": "subspecies",
            "sub genus": "subgenus",
            "sub family": "subfamily",
            "sub order": "suborder",
            "sub class": "subclass",
            "sub phylum": "subphylum",
            "var.": "variety",
            "forma": "form",
            "f.": "form",
            "no rank": "unranked",
        }

        if not rank:
            return "unknown"

        return aliases.get(
            rank,
            rank.replace(" ", "_"),
        )

    @staticmethod
    def _normalize_status(value: Any) -> str:
        """Normalize AmphibiaWeb taxonomic status labels."""

        status = normalize_space(value).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "valid",
            "current": "accepted",
            "synonym": "synonym",
            "junior synonym": "synonym",
            "unaccepted": "synonym",
            "misapplied": "misapplied",
            "questionable": "unknown",
            "doubtful": "unknown",
            "unresolved": "unknown",
            "extinct": "accepted",
            "reference": "reference",
        }

        return aliases.get(
            status,
            status or "accepted",
        )

    @staticmethod
    def _infer_rank(scientific_name: str) -> str:
        """Infer rank from amphibian scientific-name structure."""

        words = normalize_space(scientific_name).split()

        lowered = {
            word.casefold()
            for word in words
        }

        if "subsp." in lowered or "subspecies" in lowered:
            return "subspecies"

        if len(words) == 2:
            return "species"

        if len(words) >= 3:
            return "subspecies"

        return "unknown"

    @staticmethod
    def _decode_cursor(cursor: str | None) -> int:
        """Decode a non-negative JSONL record offset."""

        if not cursor:
            return 0

        try:
            offset = int(cursor)
        except (TypeError, ValueError) as error:
            raise ProviderError(
                f"Invalid AmphibiaWeb cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "AmphibiaWeb cursor must be non-negative."
            )

        return offset

    @staticmethod
    def _first_value(
        record: Mapping[str, Any],
        *keys: str,
    ) -> Any:
        for key in keys:
            value = record.get(key)

            if value not in (
                None,
                "",
                [],
                {},
            ):
                return value

        return None

    @staticmethod
    def _list_value(value: Any) -> list[Any]:
        if value is None:
            return []

        if isinstance(value, list):
            return value

        if isinstance(value, tuple):
            return list(value)

        if isinstance(value, set):
            return list(value)

        return [value]

    @staticmethod
    def _optional_int(value: Any) -> int | None:
        if value in (None, ""):
            return None

        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _optional_float(value: Any) -> float | None:
        if value in (None, ""):
            return None

        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _optional_bool(value: Any) -> bool | None:
        if isinstance(value, bool):
            return value

        if isinstance(value, int):
            return bool(value)

        normalized = normalize_space(value).casefold()

        if normalized in {
            "1",
            "true",
            "yes",
            "y",
        }:
            return True

        if normalized in {
            "0",
            "false",
            "no",
            "n",
        }:
            return False

        return None
