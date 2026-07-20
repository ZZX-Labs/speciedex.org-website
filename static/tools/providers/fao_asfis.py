#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/fao_asfis.py

FAO ASFIS provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It is intended for FAO Aquatic Sciences and Fisheries
Information System (ASFIS) species taxonomy, accepted names, ASFIS codes,
multilingual names, aquatic habitat, geographic distribution, fisheries,
aquaculture, production classifications, references, external identifiers,
and provenance metadata.

Each source record is normalized into the shared Speciedex Taxon contract while
the complete FAO ASFIS source object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "fao_asfis",
        "path": "static/data/providers/fao-asfis/species.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "FAO ASFIS",
        "source_url": "https://www.fao.org/fishery/en/collection/asfis"
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
    """File-backed FAO ASFIS provider."""

    PROVIDER_NAME = "fao_asfis"

    DEFAULT_SOURCE_NAME = "FAO ASFIS"
    DEFAULT_SOURCE_URL = (
        "https://www.fao.org/fishery/en/collection/asfis"
    )

    def fetch(self) -> Batch:
        """Read and normalize one resumable FAO ASFIS JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"FAO ASFIS export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"FAO ASFIS path is not a file: {source_path}"
            )

        offset = self._decode_cursor(self.cursor)
        configured_page_size = safe_int(
            self.definition.get("page_size", self.batch_size),
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

                if not stripped or stripped.startswith("#"):
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
                            f"Invalid FAO ASFIS JSON at "
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
            next_cursor=(
                None
                if exhausted
                else str(next_offset)
            ),
            exhausted=exhausted,
            requests=0,
            raw=raw_count,
        )

    def _source_path(self) -> Path:
        """Resolve the configured FAO ASFIS JSONL source path."""

        configured = normalize_space(
            self.definition.get("path")
            or self.definition.get("file")
            or self.definition.get("source_path")
        )

        if not configured:
            raise ProviderError(
                "FAO ASFIS provider requires a path."
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
        """Normalize one FAO ASFIS aquatic taxon record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "asfis_code",
                "asfisCode",
                "fao_code",
                "faoCode",
                "species_code",
                "speciesCode",
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

        specific_epithet = normalize_space(
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
                "accepted_scientific_name",
                "acceptedScientificName",
                "taxon_name",
                "taxonName",
                "name",
            )
        )

        if not scientific_name and genus and specific_epithet:
            scientific_name = f"{genus} {specific_epithet}"

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
                "record_status",
                "recordStatus",
            )
        )

        accepted_provider_id = normalize_space(
            self._first_value(
                raw,
                "accepted_asfis_code",
                "acceptedAsfisCode",
                "accepted_taxon_id",
                "acceptedTaxonId",
                "accepted_name_id",
                "acceptedNameId",
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
            )
        )

        if not source_url:
            base = normalize_space(
                self.definition.get(
                    "source_url",
                    self.DEFAULT_SOURCE_URL,
                )
            ).rstrip("/")

            source_url = (
                f"{base}?asfis_code={provider_id}"
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
            kingdom=lineage.get("kingdom", ""),
            phylum=lineage.get("phylum", ""),
            class_name=lineage.get("class", ""),
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
                "programme": "fao_asfis",
                "reference_only": True,
                "asfis_code": provider_id,
                "accepted_asfis_code": accepted_provider_id,
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
                "taxonomy": {
                    "subfamily": normalize_space(
                        self._first_value(
                            raw,
                            "subfamily",
                        )
                    ),
                    "tribe": normalize_space(
                        self._first_value(
                            raw,
                            "tribe",
                        )
                    ),
                    "subgenus": normalize_space(
                        self._first_value(
                            raw,
                            "subgenus",
                        )
                    ),
                    "species_group": normalize_space(
                        self._first_value(
                            raw,
                            "species_group",
                            "speciesGroup",
                        )
                    ),
                    "taxonomic_notes": normalize_space(
                        self._first_value(
                            raw,
                            "taxonomic_notes",
                            "taxonomicNotes",
                            "remarks",
                        )
                    ),
                    "nomenclatural_code": normalize_space(
                        self._first_value(
                            raw,
                            "nomenclatural_code",
                            "nomenclaturalCode",
                        )
                    ),
                },
                "synonym_records": self._normalize_synonym_records(
                    self._first_value(
                        raw,
                        "synonyms",
                        "synonym_records",
                        "synonymRecords",
                        "taxonomic_synonyms",
                        "taxonomicSynonyms",
                    )
                ),
                "fao_names": self._normalize_common_names(
                    self._first_value(
                        raw,
                        "fao_names",
                        "faoNames",
                        "common_names",
                        "commonNames",
                        "vernacular_names",
                        "vernacularNames",
                    ),
                    english=normalize_space(
                        self._first_value(
                            raw,
                            "english_name",
                            "englishName",
                            "fao_english_name",
                            "faoEnglishName",
                        )
                    ),
                    french=normalize_space(
                        self._first_value(
                            raw,
                            "french_name",
                            "frenchName",
                            "fao_french_name",
                            "faoFrenchName",
                        )
                    ),
                    spanish=normalize_space(
                        self._first_value(
                            raw,
                            "spanish_name",
                            "spanishName",
                            "fao_spanish_name",
                            "faoSpanishName",
                        )
                    ),
                ),
                "aquatic_environment": {
                    "marine": self._optional_bool(
                        self._first_value(
                            raw,
                            "marine",
                            "is_marine",
                            "isMarine",
                        )
                    ),
                    "freshwater": self._optional_bool(
                        self._first_value(
                            raw,
                            "freshwater",
                            "is_freshwater",
                            "isFreshwater",
                        )
                    ),
                    "brackish": self._optional_bool(
                        self._first_value(
                            raw,
                            "brackish",
                            "is_brackish",
                            "isBrackish",
                        )
                    ),
                    "anadromous": self._optional_bool(
                        self._first_value(
                            raw,
                            "anadromous",
                            "is_anadromous",
                            "isAnadromous",
                        )
                    ),
                    "catadromous": self._optional_bool(
                        self._first_value(
                            raw,
                            "catadromous",
                            "is_catadromous",
                            "isCatadromous",
                        )
                    ),
                    "amphidromous": self._optional_bool(
                        self._first_value(
                            raw,
                            "amphidromous",
                            "is_amphidromous",
                            "isAmphidromous",
                        )
                    ),
                    "pelagic": self._optional_bool(
                        self._first_value(
                            raw,
                            "pelagic",
                            "is_pelagic",
                            "isPelagic",
                        )
                    ),
                    "demersal": self._optional_bool(
                        self._first_value(
                            raw,
                            "demersal",
                            "is_demersal",
                            "isDemersal",
                        )
                    ),
                    "benthic": self._optional_bool(
                        self._first_value(
                            raw,
                            "benthic",
                            "is_benthic",
                            "isBenthic",
                        )
                    ),
                    "habitats": self._list_value(
                        self._first_value(
                            raw,
                            "habitats",
                            "habitat",
                        )
                    ),
                    "depth_min_m": self._optional_float(
                        self._first_value(
                            raw,
                            "depth_min_m",
                            "depthMinM",
                            "minimum_depth",
                            "minimumDepth",
                        )
                    ),
                    "depth_max_m": self._optional_float(
                        self._first_value(
                            raw,
                            "depth_max_m",
                            "depthMaxM",
                            "maximum_depth",
                            "maximumDepth",
                        )
                    ),
                },
                "distribution": {
                    "summary": self._first_value(
                        raw,
                        "distribution",
                        "geographic_distribution",
                        "geographicDistribution",
                        "range",
                    ),
                    "fao_major_fishing_areas": self._normalize_regions(
                        self._first_value(
                            raw,
                            "fao_major_fishing_areas",
                            "faoMajorFishingAreas",
                            "major_fishing_areas",
                            "majorFishingAreas",
                        )
                    ),
                    "countries": self._normalize_regions(
                        self._first_value(
                            raw,
                            "countries",
                            "country_records",
                            "countryRecords",
                        )
                    ),
                    "marine_regions": self._normalize_regions(
                        self._first_value(
                            raw,
                            "marine_regions",
                            "marineRegions",
                            "regions",
                        )
                    ),
                    "native": self._optional_bool(
                        self._first_value(
                            raw,
                            "native",
                            "is_native",
                            "isNative",
                        )
                    ),
                    "introduced": self._optional_bool(
                        self._first_value(
                            raw,
                            "introduced",
                            "is_introduced",
                            "isIntroduced",
                        )
                    ),
                    "invasive": self._optional_bool(
                        self._first_value(
                            raw,
                            "invasive",
                            "is_invasive",
                            "isInvasive",
                        )
                    ),
                },
                "fishery": {
                    "fishery_species": self._optional_bool(
                        self._first_value(
                            raw,
                            "fishery_species",
                            "fisherySpecies",
                        )
                    ),
                    "commercial_importance": normalize_space(
                        self._first_value(
                            raw,
                            "commercial_importance",
                            "commercialImportance",
                        )
                    ),
                    "fishery_importance": normalize_space(
                        self._first_value(
                            raw,
                            "fishery_importance",
                            "fisheryImportance",
                        )
                    ),
                    "capture_categories": self._list_value(
                        self._first_value(
                            raw,
                            "capture_categories",
                            "captureCategories",
                            "fishery_categories",
                            "fisheryCategories",
                        )
                    ),
                    "gear_types": self._list_value(
                        self._first_value(
                            raw,
                            "gear_types",
                            "gearTypes",
                        )
                    ),
                    "product_forms": self._list_value(
                        self._first_value(
                            raw,
                            "product_forms",
                            "productForms",
                        )
                    ),
                    "markets": self._list_value(
                        self._first_value(
                            raw,
                            "markets",
                            "market",
                        )
                    ),
                },
                "aquaculture": {
                    "aquaculture_species": self._optional_bool(
                        self._first_value(
                            raw,
                            "aquaculture_species",
                            "aquacultureSpecies",
                        )
                    ),
                    "culture_systems": self._list_value(
                        self._first_value(
                            raw,
                            "culture_systems",
                            "cultureSystems",
                        )
                    ),
                    "production_environments": self._list_value(
                        self._first_value(
                            raw,
                            "production_environments",
                            "productionEnvironments",
                        )
                    ),
                    "aquaculture_notes": normalize_space(
                        self._first_value(
                            raw,
                            "aquaculture_notes",
                            "aquacultureNotes",
                        )
                    ),
                },
                "production": {
                    "isscaap_group": normalize_space(
                        self._first_value(
                            raw,
                            "isscaap_group",
                            "isscaapGroup",
                        )
                    ),
                    "isscaap_group_code": normalize_space(
                        self._first_value(
                            raw,
                            "isscaap_group_code",
                            "isscaapGroupCode",
                        )
                    ),
                    "taxonomic_group": normalize_space(
                        self._first_value(
                            raw,
                            "taxonomic_group",
                            "taxonomicGroup",
                        )
                    ),
                    "production_categories": self._list_value(
                        self._first_value(
                            raw,
                            "production_categories",
                            "productionCategories",
                        )
                    ),
                    "statistical_use": self._optional_bool(
                        self._first_value(
                            raw,
                            "statistical_use",
                            "statisticalUse",
                        )
                    ),
                    "landings_recorded": self._optional_bool(
                        self._first_value(
                            raw,
                            "landings_recorded",
                            "landingsRecorded",
                        )
                    ),
                },
                "biology": {
                    "maximum_length_cm": self._optional_float(
                        self._first_value(
                            raw,
                            "maximum_length_cm",
                            "maximumLengthCm",
                            "max_length_cm",
                            "maxLengthCm",
                        )
                    ),
                    "common_length_cm": self._optional_float(
                        self._first_value(
                            raw,
                            "common_length_cm",
                            "commonLengthCm",
                        )
                    ),
                    "maximum_weight_kg": self._optional_float(
                        self._first_value(
                            raw,
                            "maximum_weight_kg",
                            "maximumWeightKg",
                        )
                    ),
                    "trophic_level": self._optional_float(
                        self._first_value(
                            raw,
                            "trophic_level",
                            "trophicLevel",
                        )
                    ),
                    "feeding": self._list_value(
                        self._first_value(
                            raw,
                            "feeding",
                            "diet",
                        )
                    ),
                    "reproduction": normalize_space(
                        self._first_value(
                            raw,
                            "reproduction",
                            "breeding",
                        )
                    ),
                    "migration": normalize_space(
                        self._first_value(
                            raw,
                            "migration",
                            "movement",
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
                    "cites_status": normalize_space(
                        self._first_value(
                            raw,
                            "cites_status",
                            "citesStatus",
                        )
                    ),
                    "cms_status": normalize_space(
                        self._first_value(
                            raw,
                            "cms_status",
                            "cmsStatus",
                        )
                    ),
                    "stock_status": normalize_space(
                        self._first_value(
                            raw,
                            "stock_status",
                            "stockStatus",
                        )
                    ),
                    "management_measures": self._list_value(
                        self._first_value(
                            raw,
                            "management_measures",
                            "managementMeasures",
                        )
                    ),
                },
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
                "media": self._normalize_media(
                    self._first_value(
                        raw,
                        "media",
                        "images",
                        "image",
                        "maps",
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
        """Extract aquatic taxonomic lineage."""

        lineage = {
            "kingdom": normalize_space(
                raw.get("kingdom")
            ),
            "phylum": normalize_space(
                raw.get("phylum")
            ),
            "class": normalize_space(
                raw.get("class")
            ),
            "order": normalize_space(
                raw.get("order")
            ),
            "family": normalize_space(
                raw.get("family")
            ),
            "subfamily": normalize_space(
                raw.get("subfamily")
            ),
            "genus": genus or normalize_space(
                raw.get("genus")
            ),
            "species": normalize_space(
                raw.get("species")
            ),
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
        """Extract and deduplicate taxonomic synonyms."""

        values = cls._list_value(
            cls._first_value(
                raw,
                "synonyms",
                "synonym",
                "synonym_records",
                "synonymRecords",
                "taxonomic_synonyms",
                "taxonomicSynonyms",
                "former_names",
                "formerNames",
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
                name = normalize_space(
                    cls._first_value(
                        item,
                        "scientific_name",
                        "scientificName",
                        "name",
                    )
                )
            else:
                name = normalize_space(item)

            key = name.casefold()

            if not name or key in seen:
                continue

            seen.add(key)
            result.append(name)

        return result

    @classmethod
    def _normalize_synonym_records(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize synonym records."""

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
                                "scientific_name",
                                "scientificName",
                            )
                        ),
                        "id": normalize_space(
                            cls._first_value(
                                item,
                                "id",
                                "taxon_id",
                                "taxonId",
                                "asfis_code",
                                "asfisCode",
                            )
                        ),
                        "authorship": normalize_space(
                            cls._first_value(
                                item,
                                "authorship",
                                "author",
                                "authority",
                            )
                        ),
                        "status": cls._normalize_status(
                            cls._first_value(
                                item,
                                "status",
                                "name_status",
                                "nameStatus",
                            )
                        ),
                        "reference": normalize_space(
                            cls._first_value(
                                item,
                                "reference",
                                "citation",
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
                            "id": "",
                            "authorship": "",
                            "status": "synonym",
                            "reference": "",
                        }
                    )

        return result

    @classmethod
    def _normalize_common_names(
        cls,
        value: Any,
        *,
        english: str,
        french: str,
        spanish: str,
    ) -> list[dict[str, Any]]:
        """Normalize FAO multilingual names."""

        values = cls._list_value(value)

        configured = (
            ("en", english),
            ("fr", french),
            ("es", spanish),
        )

        for language, name in reversed(configured):
            if name:
                values.insert(
                    0,
                    {
                        "name": name,
                        "language": language,
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
                region = normalize_space(
                    cls._first_value(
                        item,
                        "region",
                        "country",
                        "area",
                    )
                )
                preferred = cls._optional_bool(
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
                region = ""
                preferred = None
                raw_item = item

            key = (
                name.casefold(),
                language.casefold(),
                region.casefold(),
            )

            if not name or key in seen:
                continue

            seen.add(key)
            result.append(
                {
                    "name": name,
                    "language": language,
                    "region": region,
                    "preferred": preferred,
                    "raw": raw_item,
                }
            )

        return result

    @classmethod
    def _normalize_regions(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize countries, marine regions, and FAO fishing areas."""

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
                                "area_code",
                                "areaCode",
                                "fao_area_code",
                                "faoAreaCode",
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
    def _normalize_identifiers(
        cls,
        value: Any,
        *,
        raw: Mapping[str, Any],
    ) -> list[dict[str, str]]:
        """Normalize FAO ASFIS and external identifiers."""

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
            "fishbase_id": "FishBase",
            "fishbaseId": "FishBase",
            "sealifebase_id": "SeaLifeBase",
            "sealifebaseId": "SeaLifeBase",
            "worms_id": "WoRMS",
            "wormsId": "WoRMS",
            "gbif_id": "GBIF",
            "gbifId": "GBIF",
            "itis_tsn": "ITIS",
            "itisTsn": "ITIS",
            "col_id": "Catalogue of Life",
            "colId": "Catalogue of Life",
            "iucn_id": "IUCN",
            "iucnId": "IUCN",
            "cites_id": "CITES",
            "citesId": "CITES",
            "ncbi_taxid": "NCBI Taxonomy",
            "ncbiTaxid": "NCBI Taxonomy",
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
        """Normalize fisheries and taxonomic references."""

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
    def _normalize_media(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize photographs, illustrations, and distribution maps."""

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
                            )
                        ),
                        "thumbnail_url": normalize_space(
                            cls._first_value(
                                item,
                                "thumbnail_url",
                                "thumbnailUrl",
                                "thumbnail",
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
                                "illustrator",
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
                    "thumbnail_url": "",
                    "type": "",
                    "title": "",
                    "creator": "",
                    "license": "",
                }

            if entry.get("url") or entry.get("thumbnail_url"):
                result.append(entry)

        return result

    @staticmethod
    def _normalize_rank(value: Any) -> str:
        """Normalize aquatic taxonomic ranks."""

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
            "super family": "superfamily",
            "no rank": "unranked",
            "species group": "species_group",
        }

        if not rank:
            return "unknown"

        return aliases.get(
            rank,
            rank.replace(" ", "_"),
        )

    @staticmethod
    def _normalize_status(value: Any) -> str:
        """Normalize FAO ASFIS taxonomic and record statuses."""

        status = normalize_space(value).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "valid",
            "current": "accepted",
            "official": "accepted",
            "active": "accepted",
            "synonym": "synonym",
            "junior synonym": "synonym",
            "unaccepted": "synonym",
            "obsolete": "inactive",
            "deprecated": "inactive",
            "inactive": "inactive",
            "misapplied": "misapplied",
            "doubtful": "unknown",
            "unresolved": "unknown",
            "reference": "reference",
        }

        return aliases.get(
            status,
            status or "reference",
        )

    @staticmethod
    def _infer_rank(scientific_name: str) -> str:
        """Infer rank from scientific-name structure."""

        words = normalize_space(scientific_name).split()
        lowered = {word.casefold() for word in words}

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
                f"Invalid FAO ASFIS cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "FAO ASFIS cursor must be non-negative."
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
            "present",
            "active",
        }:
            return True

        if normalized in {
            "0",
            "false",
            "no",
            "n",
            "absent",
            "inactive",
        }:
            return False

        return None
