#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/cms_species.py

Convention on the Conservation of Migratory Species of Wild Animals (CMS)
provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It is intended for CMS-listed taxa, appendices,
agreements, memoranda of understanding, geographic coverage, migratory status,
population information, conservation measures, threats, references, and
provenance metadata.

Each source record is normalized into the shared Speciedex Taxon contract while
the complete CMS source object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "cms_species",
        "path": "static/data/providers/cms-species/species.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "Convention on Migratory Species",
        "source_url": "https://www.cms.int/"
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
    """File-backed CMS species provider."""

    PROVIDER_NAME = "cms_species"

    DEFAULT_SOURCE_NAME = "Convention on Migratory Species"
    DEFAULT_SOURCE_URL = "https://www.cms.int/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable CMS JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"CMS species export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"CMS species path is not a file: {source_path}"
            )

        offset = self._decode_cursor(self.cursor)
        configured_page_size = safe_int(
            self.definition.get("page_size", self.batch_size),
            self.batch_size,
        )
        page_size = max(1, min(configured_page_size, self.batch_size))

        records: list[Taxon] = []
        raw_count = 0
        next_offset = offset
        exhausted = True
        retrieved_at = now()

        with source_path.open("r", encoding="utf-8") as handle:
            logical_index = 0

            for physical_line, line in enumerate(handle, start=1):
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
                            f"Invalid CMS JSON at "
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
        """Resolve the configured CMS JSONL source path."""

        configured = normalize_space(
            self.definition.get("path")
            or self.definition.get("file")
            or self.definition.get("source_path")
        )

        if not configured:
            raise ProviderError(
                "CMS species provider requires a path."
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
        """Normalize one CMS-listed taxon record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "cms_id",
                "cmsId",
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
            )
        )

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "full_name",
                "fullName",
                "taxon_name",
                "taxonName",
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
                "listing_status",
                "listingStatus",
            )
        )

        accepted_provider_id = normalize_space(
            self._first_value(
                raw,
                "accepted_name_id",
                "acceptedNameId",
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
                + "/species/"
                + provider_id
            )

        lineage = self._extract_lineage(raw, genus=genus)

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
                "programme": "cms_species",
                "reference_only": True,
                "cms_id": provider_id,
                "accepted_name_id": accepted_provider_id,
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
                "cms_listing": {
                    "appendices": self._normalize_appendices(
                        self._first_value(
                            raw,
                            "appendices",
                            "appendix",
                            "cms_appendices",
                            "cmsAppendices",
                        )
                    ),
                    "listing_date": normalize_space(
                        self._first_value(
                            raw,
                            "listing_date",
                            "listingDate",
                            "date_listed",
                            "dateListed",
                        )
                    ),
                    "effective_date": normalize_space(
                        self._first_value(
                            raw,
                            "effective_date",
                            "effectiveDate",
                        )
                    ),
                    "listing_notes": normalize_space(
                        self._first_value(
                            raw,
                            "listing_notes",
                            "listingNotes",
                        )
                    ),
                    "population_listing": self._list_value(
                        self._first_value(
                            raw,
                            "population_listing",
                            "populationListing",
                            "listed_populations",
                            "listedPopulations",
                        )
                    ),
                    "geographic_scope": self._list_value(
                        self._first_value(
                            raw,
                            "geographic_scope",
                            "geographicScope",
                        )
                    ),
                },
                "agreements": self._normalize_agreements(
                    self._first_value(
                        raw,
                        "agreements",
                        "agreement",
                        "instruments",
                        "legal_instruments",
                        "legalInstruments",
                    )
                ),
                "memoranda": self._normalize_agreements(
                    self._first_value(
                        raw,
                        "memoranda",
                        "memoranda_of_understanding",
                        "memorandaOfUnderstanding",
                        "mous",
                    )
                ),
                "migration": {
                    "migratory": self._optional_bool(
                        self._first_value(
                            raw,
                            "migratory",
                            "is_migratory",
                            "isMigratory",
                        )
                    ),
                    "migration_type": self._list_value(
                        self._first_value(
                            raw,
                            "migration_type",
                            "migrationType",
                        )
                    ),
                    "migratory_routes": self._list_value(
                        self._first_value(
                            raw,
                            "migratory_routes",
                            "migratoryRoutes",
                            "flyways",
                        )
                    ),
                    "seasonality": normalize_space(
                        self._first_value(
                            raw,
                            "seasonality",
                            "migration_seasonality",
                            "migrationSeasonality",
                        )
                    ),
                    "distance_class": normalize_space(
                        self._first_value(
                            raw,
                            "distance_class",
                            "distanceClass",
                        )
                    ),
                    "cross_border": self._optional_bool(
                        self._first_value(
                            raw,
                            "cross_border",
                            "crossBorder",
                            "transboundary",
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
                    "range_states": self._normalize_regions(
                        self._first_value(
                            raw,
                            "range_states",
                            "rangeStates",
                            "countries",
                            "country_records",
                            "countryRecords",
                        )
                    ),
                    "regions": self._normalize_regions(
                        self._first_value(
                            raw,
                            "regions",
                            "region_records",
                            "regionRecords",
                        )
                    ),
                    "breeding_range": self._normalize_regions(
                        self._first_value(
                            raw,
                            "breeding_range",
                            "breedingRange",
                        )
                    ),
                    "nonbreeding_range": self._normalize_regions(
                        self._first_value(
                            raw,
                            "nonbreeding_range",
                            "nonbreedingRange",
                            "wintering_range",
                            "winteringRange",
                        )
                    ),
                    "passage_range": self._normalize_regions(
                        self._first_value(
                            raw,
                            "passage_range",
                            "passageRange",
                            "migration_range",
                            "migrationRange",
                        )
                    ),
                    "marine": self._optional_bool(
                        self._first_value(
                            raw,
                            "marine",
                            "is_marine",
                            "isMarine",
                        )
                    ),
                },
                "population": {
                    "population_size": self._first_value(
                        raw,
                        "population_size",
                        "populationSize",
                    ),
                    "population_units": normalize_space(
                        self._first_value(
                            raw,
                            "population_units",
                            "populationUnits",
                        )
                    ),
                    "population_trend": normalize_space(
                        self._first_value(
                            raw,
                            "population_trend",
                            "populationTrend",
                        )
                    ),
                    "population_notes": normalize_space(
                        self._first_value(
                            raw,
                            "population_notes",
                            "populationNotes",
                        )
                    ),
                    "subpopulations": self._list_value(
                        self._first_value(
                            raw,
                            "subpopulations",
                            "populations",
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
                    "cites_status": normalize_space(
                        self._first_value(
                            raw,
                            "cites_status",
                            "citesStatus",
                        )
                    ),
                    "national_statuses": self._list_value(
                        self._first_value(
                            raw,
                            "national_statuses",
                            "nationalStatuses",
                        )
                    ),
                    "conservation_measures": self._normalize_measures(
                        self._first_value(
                            raw,
                            "conservation_measures",
                            "conservationMeasures",
                            "measures",
                        )
                    ),
                    "action_plans": self._normalize_documents(
                        self._first_value(
                            raw,
                            "action_plans",
                            "actionPlans",
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
                "ecology": {
                    "habitats": self._list_value(
                        self._first_value(
                            raw,
                            "habitats",
                            "habitat",
                        )
                    ),
                    "diet": self._list_value(
                        self._first_value(
                            raw,
                            "diet",
                            "food",
                        )
                    ),
                    "breeding": normalize_space(
                        self._first_value(
                            raw,
                            "breeding",
                            "breeding_biology",
                            "breedingBiology",
                        )
                    ),
                    "generation_length_years": self._optional_float(
                        self._first_value(
                            raw,
                            "generation_length",
                            "generationLength",
                        )
                    ),
                },
                "meetings_and_resolutions": self._normalize_documents(
                    self._first_value(
                        raw,
                        "meetings_and_resolutions",
                        "meetingsAndResolutions",
                        "resolutions",
                        "decisions",
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
        """Extract taxonomic lineage."""

        lineage = {
            "kingdom": normalize_space(
                raw.get("kingdom")
            ) or "Animalia",
            "phylum": normalize_space(raw.get("phylum")),
            "class": normalize_space(raw.get("class")),
            "order": normalize_space(raw.get("order")),
            "family": normalize_space(raw.get("family")),
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
        """Extract and deduplicate taxonomic synonyms."""

        values = cls._list_value(
            cls._first_value(
                raw,
                "synonyms",
                "synonym",
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
                value = normalize_space(
                    cls._first_value(
                        item,
                        "scientific_name",
                        "scientificName",
                        "name",
                    )
                )
            else:
                value = normalize_space(item)

            key = value.casefold()

            if not value or key in seen:
                continue

            seen.add(key)
            result.append(value)

        return result

    @classmethod
    def _normalize_common_names(
        cls,
        value: Any,
        *,
        preferred: str,
    ) -> list[dict[str, Any]]:
        """Normalize multilingual common names."""

        values = cls._list_value(value)

        if preferred:
            values.insert(
                0,
                {
                    "name": preferred,
                    "language": "en",
                    "preferred": True,
                },
            )

        result: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()

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
                preferred_value = None
                raw_item = item

            key = (name.casefold(), language.casefold())

            if not name or key in seen:
                continue

            seen.add(key)
            result.append(
                {
                    "name": name,
                    "language": language,
                    "preferred": preferred_value,
                    "raw": raw_item,
                }
            )

        return result

    @classmethod
    def _normalize_appendices(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize CMS Appendix I and Appendix II listings."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                appendix = normalize_space(
                    cls._first_value(
                        item,
                        "appendix",
                        "name",
                        "value",
                    )
                )
                date = normalize_space(
                    cls._first_value(
                        item,
                        "date",
                        "listing_date",
                        "listingDate",
                    )
                )
                population = normalize_space(
                    cls._first_value(
                        item,
                        "population",
                        "scope",
                    )
                )
                notes = normalize_space(
                    cls._first_value(
                        item,
                        "notes",
                        "remarks",
                    )
                )
                raw_item = dict(item)
            else:
                appendix = normalize_space(item)
                date = ""
                population = ""
                notes = ""
                raw_item = item

            normalized_appendix = appendix.upper().replace(
                "APPENDIX",
                "",
            ).strip()

            if normalized_appendix in {"1", "I"}:
                normalized_appendix = "I"
            elif normalized_appendix in {"2", "II"}:
                normalized_appendix = "II"
            elif not normalized_appendix:
                continue

            result.append(
                {
                    "appendix": normalized_appendix,
                    "date": date,
                    "population": population,
                    "notes": notes,
                    "raw": raw_item,
                }
            )

        return result

    @classmethod
    def _normalize_agreements(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize CMS agreements, MoUs, and related instruments."""

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
                                "title",
                                "agreement",
                            )
                        ),
                        "type": normalize_space(
                            cls._first_value(
                                item,
                                "type",
                                "instrument_type",
                                "instrumentType",
                            )
                        ),
                        "effective_date": normalize_space(
                            cls._first_value(
                                item,
                                "effective_date",
                                "effectiveDate",
                                "date",
                            )
                        ),
                        "status": normalize_space(
                            cls._first_value(
                                item,
                                "status",
                            )
                        ),
                        "regions": cls._normalize_regions(
                            cls._first_value(
                                item,
                                "regions",
                                "range_states",
                                "rangeStates",
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

                if entry.get("name"):
                    result.append(entry)
            else:
                name = normalize_space(item)

                if name:
                    result.append(
                        {
                            "name": name,
                            "type": "",
                            "effective_date": "",
                            "status": "",
                            "regions": [],
                            "url": "",
                        }
                    )

        return result

    @classmethod
    def _normalize_regions(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize countries, range states, and regional scopes."""

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
                        "season": normalize_space(
                            cls._first_value(
                                item,
                                "season",
                                "seasonal_status",
                                "seasonalStatus",
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
                            "season": "",
                        }
                    )

        return result

    @classmethod
    def _normalize_measures(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize conservation measures."""

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
                                "measure",
                                "title",
                            )
                        ),
                        "category": normalize_space(
                            cls._first_value(
                                item,
                                "category",
                                "type",
                            )
                        ),
                        "status": normalize_space(
                            cls._first_value(
                                item,
                                "status",
                            )
                        ),
                        "description": normalize_space(
                            cls._first_value(
                                item,
                                "description",
                                "notes",
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
                name = normalize_space(item)

                if name:
                    result.append(
                        {
                            "name": name,
                            "category": "",
                            "status": "",
                            "description": "",
                            "url": "",
                        }
                    )

        return result

    @classmethod
    def _normalize_threats(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize threats to migratory species."""

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
                        "category": normalize_space(
                            cls._first_value(
                                item,
                                "category",
                                "type",
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
                            "category": "",
                            "scope": "",
                            "severity": "",
                            "timing": "",
                            "description": "",
                        }
                    )

        return result

    @classmethod
    def _normalize_documents(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize action plans, resolutions, decisions, and reports."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                entry = dict(item)
                entry.update(
                    {
                        "title": normalize_space(
                            cls._first_value(
                                item,
                                "title",
                                "name",
                            )
                        ),
                        "type": normalize_space(
                            cls._first_value(
                                item,
                                "type",
                                "document_type",
                                "documentType",
                            )
                        ),
                        "date": normalize_space(
                            cls._first_value(
                                item,
                                "date",
                                "publication_date",
                                "publicationDate",
                            )
                        ),
                        "reference": normalize_space(
                            cls._first_value(
                                item,
                                "reference",
                                "number",
                                "code",
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
                title = normalize_space(item)

                if title:
                    result.append(
                        {
                            "title": title,
                            "type": "",
                            "date": "",
                            "reference": "",
                            "url": "",
                        }
                    )

        return result

    @classmethod
    def _normalize_media(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize CMS images, maps, and related media."""

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

    @classmethod
    def _normalize_identifiers(
        cls,
        value: Any,
        *,
        raw: Mapping[str, Any],
    ) -> list[dict[str, str]]:
        """Normalize CMS and external identifiers."""

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
            "iucn_id": "IUCN",
            "iucnId": "IUCN",
            "cites_id": "CITES",
            "citesId": "CITES",
            "gbif_id": "GBIF",
            "gbifId": "GBIF",
            "itis_tsn": "ITIS",
            "itisTsn": "ITIS",
            "wikidata_id": "Wikidata",
            "wikidataId": "Wikidata",
            "eol_id": "Encyclopedia of Life",
            "eolId": "Encyclopedia of Life",
            "worms_id": "WoRMS",
            "wormsId": "WoRMS",
            "birdlife_id": "BirdLife International",
            "birdlifeId": "BirdLife International",
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
        """Normalize legal, scientific, and policy references."""

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
                            cls._first_value(item, "doi")
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

    @staticmethod
    def _normalize_rank(value: Any) -> str:
        """Normalize taxonomic ranks."""

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
        """Normalize CMS and taxonomic statuses."""

        status = normalize_space(value).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "valid",
            "current": "accepted",
            "listed": "accepted",
            "active": "accepted",
            "synonym": "synonym",
            "unaccepted": "synonym",
            "delisted": "inactive",
            "withdrawn": "inactive",
            "inactive": "inactive",
            "misapplied": "misapplied",
            "doubtful": "unknown",
            "unresolved": "unknown",
            "reference": "reference",
        }

        return aliases.get(
            status,
            status or "accepted",
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
        """Decode a non-negative JSONL offset."""

        if not cursor:
            return 0

        try:
            offset = int(cursor)
        except (TypeError, ValueError) as error:
            raise ProviderError(
                f"Invalid CMS species cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "CMS species cursor must be non-negative."
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
            "listed",
            "active",
        }:
            return True

        if normalized in {
            "0",
            "false",
            "no",
            "n",
            "unlisted",
            "inactive",
        }:
            return False

        return None
