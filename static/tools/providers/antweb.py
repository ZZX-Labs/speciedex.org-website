#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/antweb.py

AntWeb provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It is intended for ant specimen, occurrence,
distribution, imaging, and taxonomic data.

Each source record is normalized into the shared Speciedex Taxon contract while
the complete AntWeb source object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "antweb",
        "path": "static/data/providers/antweb/records.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "AntWeb",
        "source_url": "https://www.antweb.org/"
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
    """File-backed AntWeb provider."""

    PROVIDER_NAME = "antweb"

    DEFAULT_SOURCE_NAME = "AntWeb"
    DEFAULT_SOURCE_URL = "https://www.antweb.org/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable AntWeb JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"AntWeb export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"AntWeb path is not a file: {source_path}"
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
                            f"Invalid AntWeb JSON at "
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
        """Resolve the configured AntWeb JSONL source path."""

        configured = normalize_space(
            self.definition.get("path")
            or self.definition.get("file")
            or self.definition.get("source_path")
        )

        if not configured:
            raise ProviderError(
                "AntWeb provider requires a path."
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
        """Normalize one AntWeb taxon, specimen, or occurrence record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "antweb_id",
                "antwebId",
                "specimen_code",
                "specimenCode",
                "occurrence_id",
                "occurrenceId",
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
                "accepted_id",
                "acceptedId",
            )
        )

        if accepted_provider_id == provider_id:
            accepted_provider_id = ""

        specimen_code = normalize_space(
            self._first_value(
                raw,
                "specimen_code",
                "specimenCode",
                "catalog_number",
                "catalogNumber",
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

            source_url = (
                f"{base}/specimen/"
                f"{specimen_code or provider_id}"
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
            phylum=lineage.get("phylum", "Arthropoda"),
            class_name=lineage.get("class", "Insecta"),
            order=lineage.get("order", "Hymenoptera"),
            family=lineage.get("family", "Formicidae"),
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
                "programme": "antweb",
                "reference_only": True,
                "antweb_id": provider_id,
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
                "specimen": {
                    "specimen_code": specimen_code,
                    "occurrence_id": normalize_space(
                        self._first_value(
                            raw,
                            "occurrence_id",
                            "occurrenceId",
                            "occurrenceID",
                        )
                    ),
                    "catalog_number": normalize_space(
                        self._first_value(
                            raw,
                            "catalog_number",
                            "catalogNumber",
                        )
                    ),
                    "record_number": normalize_space(
                        self._first_value(
                            raw,
                            "record_number",
                            "recordNumber",
                        )
                    ),
                    "basis_of_record": normalize_space(
                        self._first_value(
                            raw,
                            "basis_of_record",
                            "basisOfRecord",
                        )
                    ),
                    "type_status": normalize_space(
                        self._first_value(
                            raw,
                            "type_status",
                            "typeStatus",
                        )
                    ),
                    "caste": normalize_space(
                        self._first_value(
                            raw,
                            "caste",
                            "specimen_caste",
                            "specimenCaste",
                        )
                    ),
                    "subcaste": normalize_space(
                        self._first_value(
                            raw,
                            "subcaste",
                            "specimen_subcaste",
                            "specimenSubcaste",
                        )
                    ),
                    "sex": normalize_space(
                        self._first_value(raw, "sex")
                    ),
                    "life_stage": normalize_space(
                        self._first_value(
                            raw,
                            "life_stage",
                            "lifeStage",
                        )
                    ),
                    "individual_count": self._optional_int(
                        self._first_value(
                            raw,
                            "individual_count",
                            "individualCount",
                        )
                    ),
                    "preparations": normalize_space(
                        self._first_value(
                            raw,
                            "preparations",
                        )
                    ),
                    "disposition": normalize_space(
                        self._first_value(
                            raw,
                            "disposition",
                        )
                    ),
                    "institution_code": normalize_space(
                        self._first_value(
                            raw,
                            "institution_code",
                            "institutionCode",
                        )
                    ),
                    "collection_code": normalize_space(
                        self._first_value(
                            raw,
                            "collection_code",
                            "collectionCode",
                        )
                    ),
                    "owner_institution_code": normalize_space(
                        self._first_value(
                            raw,
                            "owner_institution_code",
                            "ownerInstitutionCode",
                        )
                    ),
                },
                "collection_event": {
                    "collected_by": normalize_space(
                        self._first_value(
                            raw,
                            "collected_by",
                            "collectedBy",
                            "recorded_by",
                            "recordedBy",
                        )
                    ),
                    "collector_number": normalize_space(
                        self._first_value(
                            raw,
                            "collector_number",
                            "collectorNumber",
                            "field_number",
                            "fieldNumber",
                        )
                    ),
                    "event_date": normalize_space(
                        self._first_value(
                            raw,
                            "event_date",
                            "eventDate",
                            "collection_date",
                            "collectionDate",
                        )
                    ),
                    "year": self._optional_int(
                        self._first_value(raw, "year")
                    ),
                    "month": self._optional_int(
                        self._first_value(raw, "month")
                    ),
                    "day": self._optional_int(
                        self._first_value(raw, "day")
                    ),
                    "sampling_protocol": normalize_space(
                        self._first_value(
                            raw,
                            "sampling_protocol",
                            "samplingProtocol",
                            "collection_method",
                            "collectionMethod",
                        )
                    ),
                    "sampling_effort": normalize_space(
                        self._first_value(
                            raw,
                            "sampling_effort",
                            "samplingEffort",
                        )
                    ),
                    "field_notes": normalize_space(
                        self._first_value(
                            raw,
                            "field_notes",
                            "fieldNotes",
                        )
                    ),
                },
                "location": {
                    "country": normalize_space(
                        self._first_value(
                            raw,
                            "country",
                        )
                    ),
                    "country_code": normalize_space(
                        self._first_value(
                            raw,
                            "country_code",
                            "countryCode",
                        )
                    ),
                    "state_province": normalize_space(
                        self._first_value(
                            raw,
                            "state_province",
                            "stateProvince",
                        )
                    ),
                    "county": normalize_space(
                        self._first_value(raw, "county")
                    ),
                    "municipality": normalize_space(
                        self._first_value(raw, "municipality")
                    ),
                    "locality": normalize_space(
                        self._first_value(
                            raw,
                            "locality",
                            "location",
                        )
                    ),
                    "verbatim_locality": normalize_space(
                        self._first_value(
                            raw,
                            "verbatim_locality",
                            "verbatimLocality",
                        )
                    ),
                    "latitude": self._optional_float(
                        self._first_value(
                            raw,
                            "decimal_latitude",
                            "decimalLatitude",
                            "latitude",
                            "lat",
                        )
                    ),
                    "longitude": self._optional_float(
                        self._first_value(
                            raw,
                            "decimal_longitude",
                            "decimalLongitude",
                            "longitude",
                            "lon",
                            "lng",
                        )
                    ),
                    "geodetic_datum": normalize_space(
                        self._first_value(
                            raw,
                            "geodetic_datum",
                            "geodeticDatum",
                        )
                    ),
                    "coordinate_uncertainty_m": self._optional_float(
                        self._first_value(
                            raw,
                            "coordinate_uncertainty_m",
                            "coordinateUncertaintyInMeters",
                        )
                    ),
                    "elevation_min_m": self._optional_float(
                        self._first_value(
                            raw,
                            "minimum_elevation_m",
                            "minimumElevationInMeters",
                            "elevation_min",
                            "elevationMin",
                        )
                    ),
                    "elevation_max_m": self._optional_float(
                        self._first_value(
                            raw,
                            "maximum_elevation_m",
                            "maximumElevationInMeters",
                            "elevation_max",
                            "elevationMax",
                        )
                    ),
                    "habitat": normalize_space(
                        self._first_value(raw, "habitat")
                    ),
                    "microhabitat": normalize_space(
                        self._first_value(
                            raw,
                            "microhabitat",
                        )
                    ),
                },
                "identification": {
                    "identified_by": normalize_space(
                        self._first_value(
                            raw,
                            "identified_by",
                            "identifiedBy",
                        )
                    ),
                    "date_identified": normalize_space(
                        self._first_value(
                            raw,
                            "date_identified",
                            "dateIdentified",
                        )
                    ),
                    "identification_qualifier": normalize_space(
                        self._first_value(
                            raw,
                            "identification_qualifier",
                            "identificationQualifier",
                        )
                    ),
                    "identification_remarks": normalize_space(
                        self._first_value(
                            raw,
                            "identification_remarks",
                            "identificationRemarks",
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
                    "invasive": self._optional_bool(
                        self._first_value(
                            raw,
                            "invasive",
                            "is_invasive",
                            "isInvasive",
                        )
                    ),
                },
                "ecology": {
                    "habitats": self._list_value(
                        self._first_value(
                            raw,
                            "habitats",
                            "habitat_types",
                            "habitatTypes",
                        )
                    ),
                    "microhabitats": self._list_value(
                        self._first_value(
                            raw,
                            "microhabitats",
                            "microhabitat_types",
                            "microhabitatTypes",
                        )
                    ),
                    "nesting": normalize_space(
                        self._first_value(
                            raw,
                            "nesting",
                            "nesting_biology",
                            "nestingBiology",
                        )
                    ),
                    "foraging": normalize_space(
                        self._first_value(
                            raw,
                            "foraging",
                            "foraging_behavior",
                            "foragingBehavior",
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
                    "behavior": normalize_space(
                        self._first_value(
                            raw,
                            "behavior",
                            "behaviour",
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
                    "body_length_mm": self._optional_float(
                        self._first_value(
                            raw,
                            "body_length_mm",
                            "bodyLengthMm",
                            "body_length",
                            "bodyLength",
                        )
                    ),
                    "head_width_mm": self._optional_float(
                        self._first_value(
                            raw,
                            "head_width_mm",
                            "headWidthMm",
                        )
                    ),
                    "head_length_mm": self._optional_float(
                        self._first_value(
                            raw,
                            "head_length_mm",
                            "headLengthMm",
                        )
                    ),
                    "weber_length_mm": self._optional_float(
                        self._first_value(
                            raw,
                            "weber_length_mm",
                            "weberLengthMm",
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
                "media": self._normalize_media(
                    self._first_value(
                        raw,
                        "media",
                        "images",
                        "image",
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
                "rights": {
                    "license": normalize_space(
                        self._first_value(
                            raw,
                            "license",
                            "rights",
                        )
                    ),
                    "rights_holder": normalize_space(
                        self._first_value(
                            raw,
                            "rights_holder",
                            "rightsHolder",
                        )
                    ),
                    "attribution": normalize_space(
                        self._first_value(
                            raw,
                            "attribution",
                            "credit",
                        )
                    ),
                },
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
        """Extract ant lineage from direct or nested fields."""

        lineage = {
            "kingdom": normalize_space(
                raw.get("kingdom")
            ) or "Animalia",
            "phylum": normalize_space(
                raw.get("phylum")
            ) or "Arthropoda",
            "class": normalize_space(
                raw.get("class")
            ) or "Insecta",
            "order": normalize_space(
                raw.get("order")
            ) or "Hymenoptera",
            "superfamily": normalize_space(
                raw.get("superfamily")
            ),
            "family": normalize_space(
                raw.get("family")
            ) or "Formicidae",
            "subfamily": normalize_space(
                raw.get("subfamily")
            ),
            "tribe": normalize_space(raw.get("tribe")),
            "subtribe": normalize_space(raw.get("subtribe")),
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
    def _normalize_regions(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize distribution regions."""

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
    def _normalize_media(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize AntWeb specimen images and other media."""

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
                        "view": normalize_space(
                            cls._first_value(
                                item,
                                "view",
                                "view_name",
                                "viewName",
                                "orientation",
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
                    "view": "",
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
        """Normalize AntWeb and external identifiers."""

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
            "antcat_id": "AntCat",
            "antcatId": "AntCat",
            "gbif_id": "GBIF",
            "gbifId": "GBIF",
            "itis_tsn": "ITIS",
            "itisTsn": "ITIS",
            "wikidata_id": "Wikidata",
            "wikidataId": "Wikidata",
            "zoobank_lsid": "ZooBank",
            "zoobankLsid": "ZooBank",
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
        """Normalize literature and source references."""

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
        """Normalize ant taxonomic ranks."""

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
            "super family": "superfamily",
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
        """Normalize AntWeb taxonomic status labels."""

        status = normalize_space(value).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "valid",
            "current": "accepted",
            "synonym": "synonym",
            "unaccepted": "synonym",
            "misapplied": "misapplied",
            "questionable": "unknown",
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
                f"Invalid AntWeb cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "AntWeb cursor must be non-negative."
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
