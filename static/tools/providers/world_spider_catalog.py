#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/world_spider_catalog.py

World Spider Catalog provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It is intended for World Spider Catalog taxonomy,
accepted spider names, synonymy, authorship, nomenclature, type species,
type specimens, geographic distribution, references, external identifiers,
and provenance metadata.

Each source record is normalized into the shared Speciedex Taxon contract while
the complete World Spider Catalog source object is preserved under
``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "world_spider_catalog",
        "path": "static/data/providers/world-spider-catalog/taxa.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "World Spider Catalog",
        "source_url": "https://wsc.nmbe.ch/"
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
    """File-backed World Spider Catalog provider."""

    PROVIDER_NAME = "world_spider_catalog"

    DEFAULT_SOURCE_NAME = "World Spider Catalog"
    DEFAULT_SOURCE_URL = "https://wsc.nmbe.ch/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable World Spider Catalog JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"World Spider Catalog export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"World Spider Catalog path is not a file: {source_path}"
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
                            f"Invalid World Spider Catalog JSON at "
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
        configured = normalize_space(
            self.definition.get("path")
            or self.definition.get("file")
            or self.definition.get("source_path")
        )

        if not configured:
            raise ProviderError(
                "World Spider Catalog provider requires a path."
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
        """Normalize one World Spider Catalog taxon record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "wsc_id",
                "wscId",
                "world_spider_catalog_id",
                "worldSpiderCatalogId",
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
            )
        )

        infraspecific_epithet = normalize_space(
            self._first_value(
                raw,
                "infraspecific_epithet",
                "infraspecificEpithet",
                "subspecies",
            )
        )

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "accepted_name",
                "acceptedName",
                "valid_name",
                "validName",
                "full_name",
                "fullName",
                "name",
            )
        )

        if not scientific_name and genus and specific_epithet:
            scientific_name = f"{genus} {specific_epithet}"

            if infraspecific_epithet:
                scientific_name = (
                    f"{scientific_name} {infraspecific_epithet}"
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
                "valid_name_id",
                "validNameId",
                "accepted_taxon_id",
                "acceptedTaxonId",
            )
        )

        if accepted_provider_id == provider_id:
            accepted_provider_id = ""

        parent_provider_id = normalize_space(
            self._first_value(
                raw,
                "parent_taxon_id",
                "parentTaxonId",
                "parent_name_id",
                "parentNameId",
                "parent_id",
                "parentId",
            )
        )

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
            source_url = f"{base}/species/{provider_id}"

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
            phylum=lineage.get("phylum", "Arthropoda"),
            class_name=lineage.get("class", "Arachnida"),
            order=lineage.get("order", "Araneae"),
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
                "programme": "world_spider_catalog",
                "reference_only": True,
                "wsc_id": provider_id,
                "accepted_name_id": accepted_provider_id,
                "lineage": lineage,
                "parent": {
                    "id": parent_provider_id,
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
                "name": {
                    "genus": genus,
                    "specific_epithet": specific_epithet,
                    "infraspecific_epithet": infraspecific_epithet,
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
                        )
                    ),
                    "authority_year": normalize_space(
                        self._first_value(
                            raw,
                            "authority_year",
                            "authorityYear",
                            "publication_year",
                            "publicationYear",
                            "year",
                        )
                    ),
                    "authority_parentheses": self._optional_bool(
                        self._first_value(
                            raw,
                            "authority_parentheses",
                            "authorityParentheses",
                            "in_parentheses",
                            "inParentheses",
                        )
                    ),
                },
                "nomenclature": {
                    "nomenclatural_code": "ICZN",
                    "nomenclatural_status": normalize_space(
                        self._first_value(
                            raw,
                            "nomenclatural_status",
                            "nomenclaturalStatus",
                            "name_status",
                            "nameStatus",
                        )
                    ),
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
                            "publication_year",
                            "publicationYear",
                            "year",
                        )
                    ),
                    "page": normalize_space(
                        self._first_value(
                            raw,
                            "page",
                            "publication_page",
                            "publicationPage",
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
                    "replacement_name": normalize_space(
                        self._first_value(
                            raw,
                            "replacement_name",
                            "replacementName",
                        )
                    ),
                    "original_spelling": normalize_space(
                        self._first_value(
                            raw,
                            "original_spelling",
                            "originalSpelling",
                        )
                    ),
                    "corrected_spelling": normalize_space(
                        self._first_value(
                            raw,
                            "corrected_spelling",
                            "correctedSpelling",
                        )
                    ),
                },
                "taxonomy": {
                    "subphylum": normalize_space(raw.get("subphylum")),
                    "superclass": normalize_space(raw.get("superclass")),
                    "subclass": normalize_space(raw.get("subclass")),
                    "infraclass": normalize_space(raw.get("infraclass")),
                    "superorder": normalize_space(raw.get("superorder")),
                    "suborder": normalize_space(raw.get("suborder")),
                    "infraorder": normalize_space(raw.get("infraorder")),
                    "superfamily": normalize_space(raw.get("superfamily")),
                    "subfamily": normalize_space(raw.get("subfamily")),
                    "tribe": normalize_space(raw.get("tribe")),
                    "subtribe": normalize_space(raw.get("subtribe")),
                    "subgenus": normalize_space(raw.get("subgenus")),
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
                            "comments",
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
                "type_information": {
                    "type_status": normalize_space(
                        self._first_value(
                            raw,
                            "type_status",
                            "typeStatus",
                        )
                    ),
                    "type_species": normalize_space(
                        self._first_value(
                            raw,
                            "type_species",
                            "typeSpecies",
                        )
                    ),
                    "type_species_id": normalize_space(
                        self._first_value(
                            raw,
                            "type_species_id",
                            "typeSpeciesId",
                        )
                    ),
                    "type_locality": normalize_space(
                        self._first_value(
                            raw,
                            "type_locality",
                            "typeLocality",
                        )
                    ),
                    "type_repository": normalize_space(
                        self._first_value(
                            raw,
                            "type_repository",
                            "typeRepository",
                            "repository",
                        )
                    ),
                    "type_catalog_number": normalize_space(
                        self._first_value(
                            raw,
                            "type_catalog_number",
                            "typeCatalogNumber",
                            "catalog_number",
                            "catalogNumber",
                        )
                    ),
                    "holotype": normalize_space(
                        self._first_value(
                            raw,
                            "holotype",
                            "holotype_specimen",
                            "holotypeSpecimen",
                        )
                    ),
                    "lectotype": normalize_space(
                        self._first_value(
                            raw,
                            "lectotype",
                            "lectotype_specimen",
                            "lectotypeSpecimen",
                        )
                    ),
                    "neotype": normalize_space(
                        self._first_value(
                            raw,
                            "neotype",
                            "neotype_specimen",
                            "neotypeSpecimen",
                        )
                    ),
                },
                "distribution": {
                    "summary": self._first_value(
                        raw,
                        "distribution",
                        "range",
                        "geographic_distribution",
                        "geographicDistribution",
                    ),
                    "countries": self._normalize_regions(
                        self._first_value(
                            raw,
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
                    "endemic": self._optional_bool(
                        self._first_value(
                            raw,
                            "endemic",
                            "is_endemic",
                            "isEndemic",
                        )
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
                    "microhabitats": self._list_value(
                        self._first_value(
                            raw,
                            "microhabitats",
                            "microhabitat",
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
                    "cave_associated": self._optional_bool(
                        self._first_value(
                            raw,
                            "cave_associated",
                            "caveAssociated",
                            "troglobitic",
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
                },
                "biology": {
                    "web_type": normalize_space(
                        self._first_value(
                            raw,
                            "web_type",
                            "webType",
                        )
                    ),
                    "hunting_strategy": normalize_space(
                        self._first_value(
                            raw,
                            "hunting_strategy",
                            "huntingStrategy",
                        )
                    ),
                    "venomous": self._optional_bool(
                        self._first_value(
                            raw,
                            "venomous",
                            "is_venomous",
                            "isVenomous",
                        )
                    ),
                    "medical_importance": normalize_space(
                        self._first_value(
                            raw,
                            "medical_importance",
                            "medicalImportance",
                        )
                    ),
                    "body_length_mm": self._optional_float(
                        self._first_value(
                            raw,
                            "body_length_mm",
                            "bodyLengthMm",
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
        lineage = {
            "kingdom": normalize_space(raw.get("kingdom")) or "Animalia",
            "phylum": normalize_space(raw.get("phylum")) or "Arthropoda",
            "subphylum": normalize_space(raw.get("subphylum")),
            "class": normalize_space(raw.get("class")) or "Arachnida",
            "subclass": normalize_space(raw.get("subclass")),
            "order": normalize_space(raw.get("order")) or "Araneae",
            "suborder": normalize_space(raw.get("suborder")),
            "infraorder": normalize_space(raw.get("infraorder")),
            "superfamily": normalize_space(raw.get("superfamily")),
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
        values = cls._list_value(
            cls._first_value(
                raw,
                "synonyms",
                "synonym",
                "synonym_records",
                "synonymRecords",
                "taxonomic_synonyms",
                "taxonomicSynonyms",
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
        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                result.append(
                    {
                        "id": normalize_space(
                            cls._first_value(
                                item,
                                "id",
                                "name_id",
                                "nameId",
                                "taxon_id",
                                "taxonId",
                                "wsc_id",
                                "wscId",
                            )
                        ),
                        "name": normalize_space(
                            cls._first_value(
                                item,
                                "name",
                                "scientific_name",
                                "scientificName",
                            )
                        ),
                        "authorship": normalize_space(
                            cls._first_value(
                                item,
                                "authorship",
                                "authority",
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
                        "status": cls._normalize_status(
                            cls._first_value(
                                item,
                                "status",
                                "taxonomic_status",
                                "taxonomicStatus",
                                "nomenclatural_status",
                                "nomenclaturalStatus",
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
                            )
                        ),
                        "raw": dict(item),
                    }
                )
            else:
                name = normalize_space(item)

                if name:
                    result.append(
                        {
                            "id": "",
                            "name": name,
                            "authorship": "",
                            "year": "",
                            "status": "synonym",
                            "relationship": "",
                            "reference": "",
                            "raw": item,
                        }
                    )

        return result

    @classmethod
    def _normalize_common_names(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
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
    def _normalize_regions(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                entry = {
                    "name": normalize_space(
                        cls._first_value(
                            item,
                            "name",
                            "country",
                            "region",
                            "area",
                            "locality",
                        )
                    ),
                    "code": normalize_space(
                        cls._first_value(
                            item,
                            "code",
                            "country_code",
                            "countryCode",
                            "region_code",
                            "regionCode",
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
                    "endemic": cls._optional_bool(
                        cls._first_value(
                            item,
                            "endemic",
                            "is_endemic",
                            "isEndemic",
                        )
                    ),
                    "reference": normalize_space(
                        cls._first_value(
                            item,
                            "reference",
                            "citation",
                            "source",
                        )
                    ),
                    "raw": dict(item),
                }
            else:
                entry = {
                    "name": normalize_space(item),
                    "code": "",
                    "status": "",
                    "native": None,
                    "introduced": None,
                    "endemic": None,
                    "reference": "",
                    "raw": item,
                }

            if entry["name"] or entry["code"]:
                result.append(entry)

        return result

    @classmethod
    def _normalize_identifiers(
        cls,
        value: Any,
        *,
        raw: Mapping[str, Any],
    ) -> list[dict[str, str]]:
        result: list[dict[str, str]] = []
        seen: set[tuple[str, str]] = set()

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

            key = (source.casefold(), identifier.casefold())

            if identifier and key not in seen:
                seen.add(key)
                result.append(
                    {
                        "identifier": identifier,
                        "source": source,
                    }
                )

        known_fields = {
            "wsc_id": "World Spider Catalog",
            "wscId": "World Spider Catalog",
            "world_spider_catalog_id": "World Spider Catalog",
            "worldSpiderCatalogId": "World Spider Catalog",
            "zoobank_lsid": "ZooBank",
            "zoobankLsid": "ZooBank",
            "gbif_id": "GBIF",
            "gbifId": "GBIF",
            "itis_tsn": "ITIS",
            "itisTsn": "ITIS",
            "col_id": "Catalogue of Life",
            "colId": "Catalogue of Life",
            "ncbi_taxid": "NCBI Taxonomy",
            "ncbiTaxid": "NCBI Taxonomy",
            "bold_id": "BOLD",
            "boldId": "BOLD",
            "wikidata_id": "Wikidata",
            "wikidataId": "Wikidata",
            "eol_id": "Encyclopedia of Life",
            "eolId": "Encyclopedia of Life",
            "iucn_id": "IUCN",
            "iucnId": "IUCN",
        }

        for field, source in known_fields.items():
            identifier = normalize_space(raw.get(field))
            key = (source.casefold(), identifier.casefold())

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
        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                result.append(
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
                        "journal": normalize_space(
                            cls._first_value(
                                item,
                                "journal",
                                "source_title",
                                "sourceTitle",
                            )
                        ),
                        "volume": normalize_space(item.get("volume")),
                        "issue": normalize_space(item.get("issue")),
                        "pages": normalize_space(
                            cls._first_value(
                                item,
                                "pages",
                                "page",
                            )
                        ),
                        "doi": normalize_space(
                            item.get("doi")
                        ).removeprefix("https://doi.org/"),
                        "url": normalize_space(
                            cls._first_value(
                                item,
                                "url",
                                "source_url",
                                "sourceUrl",
                            )
                        ),
                        "wsc_reference_id": normalize_space(
                            cls._first_value(
                                item,
                                "wsc_reference_id",
                                "wscReferenceId",
                                "reference_id",
                                "referenceId",
                                "id",
                            )
                        ),
                        "raw": dict(item),
                    }
                )
            else:
                citation = normalize_space(item)

                if citation:
                    result.append(
                        {
                            "citation": citation,
                            "authors": "",
                            "year": "",
                            "journal": "",
                            "volume": "",
                            "issue": "",
                            "pages": "",
                            "doi": "",
                            "url": "",
                            "wsc_reference_id": "",
                            "raw": item,
                        }
                    )

        return result

    @classmethod
    def _normalize_media(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                entry = {
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
                    "raw": dict(item),
                }
            else:
                entry = {
                    "url": normalize_space(item),
                    "thumbnail_url": "",
                    "type": "",
                    "title": "",
                    "creator": "",
                    "license": "",
                    "raw": item,
                }

            if entry["url"] or entry["thumbnail_url"]:
                result.append(entry)

        return result

    @staticmethod
    def _normalize_rank(value: Any) -> str:
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
            "sub tribe": "subtribe",
            "sub order": "suborder",
            "infra order": "infraorder",
            "super family": "superfamily",
            "super order": "superorder",
            "sub class": "subclass",
            "infra class": "infraclass",
            "super class": "superclass",
            "sub phylum": "subphylum",
            "species group": "species_group",
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
        status = normalize_space(value).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "accepted",
            "current": "accepted",
            "recognized": "accepted",
            "synonym": "synonym",
            "junior synonym": "synonym",
            "objective synonym": "synonym",
            "subjective synonym": "synonym",
            "unaccepted": "synonym",
            "superseded combination": "synonym",
            "misapplied": "misapplied",
            "homonym": "excluded",
            "nomen nudum": "excluded",
            "unavailable": "excluded",
            "invalid": "excluded",
            "suppressed": "excluded",
            "nomen dubium": "unknown",
            "taxon inquirendum": "unknown",
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
        if not cursor:
            return 0

        try:
            offset = int(cursor)
        except (TypeError, ValueError) as error:
            raise ProviderError(
                f"Invalid World Spider Catalog cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "World Spider Catalog cursor must be non-negative."
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
