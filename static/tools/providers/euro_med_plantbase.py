#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/euro_med_plantbase.py

Euro+Med PlantBase provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It is intended for vascular-plant taxonomy,
nomenclature, synonymy, hybrid and infraspecific names, geographic
distribution, occurrence status, endemicity, native and introduced status,
bibliography, external identifiers, and provenance metadata.

Each source record is normalized into the shared Speciedex Taxon contract while
the complete Euro+Med PlantBase source object is preserved under
``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "euro_med_plantbase",
        "path": "static/data/providers/euro-med-plantbase/taxa.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "Euro+Med PlantBase",
        "source_url": "https://europlusmed.org/"
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
    """File-backed Euro+Med PlantBase provider."""

    PROVIDER_NAME = "euro_med_plantbase"

    DEFAULT_SOURCE_NAME = "Euro+Med PlantBase"
    DEFAULT_SOURCE_URL = "https://europlusmed.org/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable Euro+Med JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"Euro+Med PlantBase export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"Euro+Med PlantBase path is not a file: {source_path}"
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
                            f"Invalid Euro+Med PlantBase JSON at "
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
        """Resolve the configured Euro+Med JSONL source path."""

        configured = normalize_space(
            self.definition.get("path")
            or self.definition.get("file")
            or self.definition.get("source_path")
        )

        if not configured:
            raise ProviderError(
                "Euro+Med PlantBase provider requires a path."
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
        """Normalize one Euro+Med taxon or nomenclatural record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "euro_med_id",
                "euroMedId",
                "euromed_id",
                "euromedId",
                "taxon_id",
                "taxonId",
                "name_id",
                "nameId",
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
                "specific_epithet",
                "specificEpithet",
                "species",
                "species_epithet",
                "speciesEpithet",
            )
        )

        infraspecific_epithet = normalize_space(
            self._first_value(
                raw,
                "infraspecific_epithet",
                "infraspecificEpithet",
                "subspecies",
                "variety",
                "form",
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

        if not scientific_name and genus and specific_epithet:
            scientific_name = f"{genus} {specific_epithet}"

            if infraspecific_epithet:
                rank_marker = normalize_space(
                    self._first_value(
                        raw,
                        "infraspecific_rank",
                        "infraspecificRank",
                        "rank_marker",
                        "rankMarker",
                    )
                )
                scientific_name = " ".join(
                    part
                    for part in (
                        scientific_name,
                        rank_marker,
                        infraspecific_epithet,
                    )
                    if part
                )

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
                "name_rank",
                "nameRank",
                "infraspecific_rank",
                "infraspecificRank",
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
                "nomenclatural_status",
                "nomenclaturalStatus",
                "name_status",
                "nameStatus",
            )
        )

        accepted_provider_id = normalize_space(
            self._first_value(
                raw,
                "accepted_name_id",
                "acceptedNameId",
                "accepted_taxon_id",
                "acceptedTaxonId",
                "accepted_name_usage_id",
                "acceptedNameUsageID",
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
            source_url = (
                normalize_space(
                    self.definition.get(
                        "source_url",
                        self.DEFAULT_SOURCE_URL,
                    )
                ).rstrip("/")
                + "/taxon/"
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
            kingdom=lineage.get("kingdom", "Plantae"),
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
                "programme": "euro_med_plantbase",
                "reference_only": True,
                "euro_med_id": provider_id,
                "accepted_name_id": accepted_provider_id,
                "lineage": lineage,
                "parent": {
                    "id": normalize_space(
                        self._first_value(
                            raw,
                            "parent_taxon_id",
                            "parentTaxonId",
                            "parent_name_id",
                            "parentNameId",
                            "parent_id",
                            "parentId",
                        )
                    ),
                    "name": normalize_space(
                        self._first_value(
                            raw,
                            "parent_name",
                            "parentName",
                            "parent_name_usage",
                            "parentNameUsage",
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
                "name": {
                    "genus": genus,
                    "specific_epithet": specific_epithet,
                    "infraspecific_epithet": infraspecific_epithet,
                    "cultivar_epithet": normalize_space(
                        self._first_value(
                            raw,
                            "cultivar_epithet",
                            "cultivarEpithet",
                        )
                    ),
                    "hybrid": self._optional_bool(
                        self._first_value(
                            raw,
                            "hybrid",
                            "is_hybrid",
                            "isHybrid",
                        )
                    ),
                    "hybrid_formula": normalize_space(
                        self._first_value(
                            raw,
                            "hybrid_formula",
                            "hybridFormula",
                        )
                    ),
                    "hybrid_parent_1": normalize_space(
                        self._first_value(
                            raw,
                            "hybrid_parent_1",
                            "hybridParent1",
                        )
                    ),
                    "hybrid_parent_2": normalize_space(
                        self._first_value(
                            raw,
                            "hybrid_parent_2",
                            "hybridParent2",
                        )
                    ),
                },
                "nomenclature": {
                    "basionym": normalize_space(
                        self._first_value(
                            raw,
                            "basionym",
                            "basionym_name",
                            "basionymName",
                        )
                    ),
                    "basionym_id": normalize_space(
                        self._first_value(
                            raw,
                            "basionym_id",
                            "basionymId",
                        )
                    ),
                    "original_name": normalize_space(
                        self._first_value(
                            raw,
                            "original_name",
                            "originalName",
                            "original_combination",
                            "originalCombination",
                        )
                    ),
                    "original_name_id": normalize_space(
                        self._first_value(
                            raw,
                            "original_name_id",
                            "originalNameId",
                            "original_combination_id",
                            "originalCombinationId",
                        )
                    ),
                    "nomenclatural_status": normalize_space(
                        self._first_value(
                            raw,
                            "nomenclatural_status",
                            "nomenclaturalStatus",
                            "name_status",
                            "nameStatus",
                        )
                    ),
                    "nomenclatural_code": normalize_space(
                        self._first_value(
                            raw,
                            "nomenclatural_code",
                            "nomenclaturalCode",
                        )
                    ) or "ICNafp",
                    "publication": normalize_space(
                        self._first_value(
                            raw,
                            "name_published_in",
                            "namePublishedIn",
                            "publication",
                        )
                    ),
                    "publication_year": normalize_space(
                        self._first_value(
                            raw,
                            "name_published_in_year",
                            "namePublishedInYear",
                            "publication_year",
                            "publicationYear",
                            "year",
                        )
                    ),
                    "homonym": self._optional_bool(
                        self._first_value(
                            raw,
                            "homonym",
                            "is_homonym",
                            "isHomonym",
                        )
                    ),
                    "illegitimate": self._optional_bool(
                        self._first_value(
                            raw,
                            "illegitimate",
                            "is_illegitimate",
                            "isIllegitimate",
                        )
                    ),
                    "invalid": self._optional_bool(
                        self._first_value(
                            raw,
                            "invalid",
                            "is_invalid",
                            "isInvalid",
                        )
                    ),
                },
                "taxonomy": {
                    "subfamily": normalize_space(
                        self._first_value(raw, "subfamily")
                    ),
                    "tribe": normalize_space(
                        self._first_value(raw, "tribe")
                    ),
                    "subtribe": normalize_space(
                        self._first_value(raw, "subtribe")
                    ),
                    "section": normalize_space(
                        self._first_value(raw, "section")
                    ),
                    "subsection": normalize_space(
                        self._first_value(raw, "subsection")
                    ),
                    "series": normalize_space(
                        self._first_value(raw, "series")
                    ),
                    "taxonomic_notes": normalize_space(
                        self._first_value(
                            raw,
                            "taxonomic_notes",
                            "taxonomicNotes",
                            "comments",
                        )
                    ),
                    "concept_reference": normalize_space(
                        self._first_value(
                            raw,
                            "concept_reference",
                            "conceptReference",
                            "name_according_to",
                            "nameAccordingTo",
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
                "common_names": self._normalize_common_names(
                    self._first_value(
                        raw,
                        "common_names",
                        "commonNames",
                        "vernacular_names",
                        "vernacularNames",
                    )
                ),
                "distribution": {
                    "summary": self._first_value(
                        raw,
                        "distribution",
                        "geographic_distribution",
                        "geographicDistribution",
                        "range",
                    ),
                    "areas": self._normalize_distribution(
                        self._first_value(
                            raw,
                            "areas",
                            "distribution_areas",
                            "distributionAreas",
                            "regional_occurrences",
                            "regionalOccurrences",
                            "countries",
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
                    "cultivated": self._optional_bool(
                        self._first_value(
                            raw,
                            "cultivated",
                            "is_cultivated",
                            "isCultivated",
                        )
                    ),
                    "naturalized": self._optional_bool(
                        self._first_value(
                            raw,
                            "naturalized",
                            "is_naturalized",
                            "isNaturalized",
                        )
                    ),
                    "casual": self._optional_bool(
                        self._first_value(
                            raw,
                            "casual",
                            "is_casual",
                            "isCasual",
                        )
                    ),
                    "doubtful": self._optional_bool(
                        self._first_value(
                            raw,
                            "doubtful",
                            "is_doubtful",
                            "isDoubtful",
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
                    "endemic_areas": self._normalize_regions(
                        self._first_value(
                            raw,
                            "endemic_areas",
                            "endemicAreas",
                            "endemic_to",
                            "endemicTo",
                        )
                    ),
                },
                "life_form": {
                    "life_form": normalize_space(
                        self._first_value(
                            raw,
                            "life_form",
                            "lifeForm",
                        )
                    ),
                    "growth_form": normalize_space(
                        self._first_value(
                            raw,
                            "growth_form",
                            "growthForm",
                        )
                    ),
                    "annual": self._optional_bool(
                        self._first_value(raw, "annual")
                    ),
                    "biennial": self._optional_bool(
                        self._first_value(raw, "biennial")
                    ),
                    "perennial": self._optional_bool(
                        self._first_value(raw, "perennial")
                    ),
                    "woody": self._optional_bool(
                        self._first_value(raw, "woody")
                    ),
                    "aquatic": self._optional_bool(
                        self._first_value(raw, "aquatic")
                    ),
                },
                "ecology": {
                    "habitats": self._list_value(
                        self._first_value(
                            raw,
                            "habitats",
                            "habitat",
                        )
                    ),
                    "biomes": self._list_value(
                        self._first_value(
                            raw,
                            "biomes",
                            "biome",
                        )
                    ),
                    "elevation_min_m": self._optional_float(
                        self._first_value(
                            raw,
                            "elevation_min_m",
                            "elevationMinM",
                            "minimum_elevation",
                            "minimumElevation",
                        )
                    ),
                    "elevation_max_m": self._optional_float(
                        self._first_value(
                            raw,
                            "elevation_max_m",
                            "elevationMaxM",
                            "maximum_elevation",
                            "maximumElevation",
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
        """Extract botanical classification from direct or nested fields."""

        lineage = {
            "kingdom": normalize_space(
                raw.get("kingdom")
            ) or "Plantae",
            "phylum": normalize_space(
                cls._first_value(
                    raw,
                    "phylum",
                    "division",
                )
            ),
            "class": normalize_space(raw.get("class")),
            "order": normalize_space(raw.get("order")),
            "family": normalize_space(raw.get("family")),
            "subfamily": normalize_space(raw.get("subfamily")),
            "tribe": normalize_space(raw.get("tribe")),
            "genus": genus or normalize_space(raw.get("genus")),
            "subgenus": normalize_space(raw.get("subgenus")),
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
        """Extract and deduplicate botanical synonyms."""

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
    def _normalize_synonym_records(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize synonym and name-relationship records."""

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
                                "name_id",
                                "nameId",
                                "taxon_id",
                                "taxonId",
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
                        "relationship": normalize_space(
                            cls._first_value(
                                item,
                                "relationship",
                                "relation",
                                "type",
                            )
                        ),
                        "reference": normalize_space(
                            cls._first_value(
                                item,
                                "reference",
                                "citation",
                                "published_in",
                                "publishedIn",
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
                            "relationship": "",
                            "reference": "",
                        }
                    )

        return result

    @classmethod
    def _normalize_common_names(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize multilingual plant common names."""

        result: list[dict[str, Any]] = []
        seen: set[tuple[str, str, str]] = set()

        for item in cls._list_value(value):
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
    def _normalize_distribution(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize Euro+Med regional occurrence records."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                entry = dict(item)
                entry.update(
                    {
                        "area": normalize_space(
                            cls._first_value(
                                item,
                                "area",
                                "name",
                                "region",
                                "country",
                            )
                        ),
                        "code": normalize_space(
                            cls._first_value(
                                item,
                                "code",
                                "area_code",
                                "areaCode",
                                "country_code",
                                "countryCode",
                            )
                        ),
                        "presence": normalize_space(
                            cls._first_value(
                                item,
                                "presence",
                                "status",
                                "occurrence_status",
                                "occurrenceStatus",
                            )
                        ),
                        "native": cls._optional_bool(
                            cls._first_value(
                                item,
                                "native",
                                "is_native",
                                "isNative",
                            )
                        ),
                        "introduced": cls._optional_bool(
                            cls._first_value(
                                item,
                                "introduced",
                                "is_introduced",
                                "isIntroduced",
                            )
                        ),
                        "cultivated": cls._optional_bool(
                            cls._first_value(
                                item,
                                "cultivated",
                                "is_cultivated",
                                "isCultivated",
                            )
                        ),
                        "naturalized": cls._optional_bool(
                            cls._first_value(
                                item,
                                "naturalized",
                                "is_naturalized",
                                "isNaturalized",
                            )
                        ),
                        "casual": cls._optional_bool(
                            cls._first_value(
                                item,
                                "casual",
                                "is_casual",
                                "isCasual",
                            )
                        ),
                        "doubtful": cls._optional_bool(
                            cls._first_value(
                                item,
                                "doubtful",
                                "is_doubtful",
                                "isDoubtful",
                            )
                        ),
                        "endemic": cls._optional_bool(
                            cls._first_value(
                                item,
                                "endemic",
                                "is_endemic",
                                "isEndemic",
                            )
                        ),
                        "extinct": cls._optional_bool(
                            cls._first_value(
                                item,
                                "extinct",
                                "is_extinct",
                                "isExtinct",
                            )
                        ),
                    }
                )

                if entry.get("area") or entry.get("code"):
                    result.append(entry)
            else:
                area = normalize_space(item)

                if area:
                    result.append(
                        {
                            "area": area,
                            "code": "",
                            "presence": "",
                            "native": None,
                            "introduced": None,
                            "cultivated": None,
                            "naturalized": None,
                            "casual": None,
                            "doubtful": None,
                            "endemic": None,
                            "extinct": None,
                        }
                    )

        return result

    @classmethod
    def _normalize_regions(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize region and country values."""

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
                                "region",
                                "country",
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
        """Normalize Euro+Med and external botanical identifiers."""

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
            "ipni_id": "IPNI",
            "ipniId": "IPNI",
            "powo_id": "Plants of the World Online",
            "powoId": "Plants of the World Online",
            "wfo_id": "World Flora Online",
            "wfoId": "World Flora Online",
            "gbif_id": "GBIF",
            "gbifId": "GBIF",
            "itis_tsn": "ITIS",
            "itisTsn": "ITIS",
            "col_id": "Catalogue of Life",
            "colId": "Catalogue of Life",
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
        """Normalize botanical and nomenclatural references."""

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

    @classmethod
    def _normalize_media(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize images and other media."""

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

    @staticmethod
    def _normalize_rank(value: Any) -> str:
        """Normalize botanical ranks."""

        rank = normalize_space(value).casefold().replace(
            "_",
            " ",
        ).replace(
            "-",
            " ",
        )

        aliases = {
            "division": "phylum",
            "sub division": "subphylum",
            "subdivision": "subphylum",
            "sub species": "subspecies",
            "sub genus": "subgenus",
            "sub family": "subfamily",
            "sub tribe": "subtribe",
            "sub order": "suborder",
            "sub class": "subclass",
            "sub section": "subsection",
            "var.": "variety",
            "subvar.": "subvariety",
            "forma": "form",
            "f.": "form",
            "subforma": "subform",
            "f. sp.": "forma_specialis",
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
        """Normalize Euro+Med taxonomic and nomenclatural statuses."""

        status = normalize_space(value).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "accepted",
            "current": "accepted",
            "correct name": "accepted",
            "synonym": "synonym",
            "heterotypic synonym": "synonym",
            "homotypic synonym": "synonym",
            "pro parte synonym": "synonym",
            "unaccepted": "synonym",
            "misapplied": "misapplied",
            "illegitimate": "excluded",
            "invalid": "excluded",
            "nomen nudum": "excluded",
            "homonym": "excluded",
            "doubtful": "unknown",
            "unresolved": "unknown",
            "provisional": "provisionally accepted",
            "reference": "reference",
        }

        return aliases.get(
            status,
            status or "reference",
        )

    @staticmethod
    def _infer_rank(scientific_name: str) -> str:
        """Infer botanical rank from scientific-name structure."""

        words = normalize_space(scientific_name).split()
        lowered = {word.casefold() for word in words}

        if "subsp." in lowered or "subspecies" in lowered:
            return "subspecies"

        if "var." in lowered or "variety" in lowered:
            return "variety"

        if "subvar." in lowered:
            return "subvariety"

        if "f." in lowered or "forma" in lowered:
            return "form"

        if "×" in scientific_name or "x" in lowered:
            return "hybrid"

        if len(words) == 2:
            return "species"

        if len(words) >= 3:
            return "infraspecific"

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
                f"Invalid Euro+Med PlantBase cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "Euro+Med PlantBase cursor must be non-negative."
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
            "native",
            "introduced",
            "cultivated",
            "naturalized",
            "endemic",
        }:
            return True

        if normalized in {
            "0",
            "false",
            "no",
            "n",
            "absent",
        }:
            return False

        return None
