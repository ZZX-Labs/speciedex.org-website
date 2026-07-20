#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/obis.py

Ocean Biodiversity Information System (OBIS) provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It does not assume access to an undocumented,
unlicensed, or unstable public API.

Each source record is normalized into the shared Taxon contract while the
complete OBIS object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "obis",
        "path": "static/data/providers/obis/records.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "Ocean Biodiversity Information System",
        "source_url": "https://obis.org/"
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
    """File-backed Ocean Biodiversity Information System provider."""

    PROVIDER_NAME = "obis"

    DEFAULT_SOURCE_NAME = "Ocean Biodiversity Information System"
    DEFAULT_SOURCE_URL = "https://obis.org/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable OBIS JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"OBIS export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"OBIS path is not a file: {source_path}"
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

    def _source_path(self) -> Path:
        """Resolve the configured OBIS JSONL source path."""

        configured = normalize_space(
            self.definition.get(
                "path"
            )
        )

        if not configured:
            raise ProviderError(
                "OBIS provider requires a path."
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
        """Normalize one OBIS occurrence or taxon record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "taxon_id",
                "taxonId",
                "taxonID",
                "aphia_id",
                "aphiaId",
                "aphiaID",
                "scientific_name_id",
                "scientificNameID",
                "id",
            )
        )

        occurrence_id = normalize_space(
            self._first_value(
                raw,
                "occurrence_id",
                "occurrenceId",
                "occurrenceID",
                "record_id",
                "recordId",
            )
        )

        if not provider_id:
            provider_id = occurrence_id

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

        if not provider_id or not scientific_name:
            return None

        canonical_name = normalize_space(
            self._first_value(
                raw,
                "canonical_name",
                "canonicalName",
                "accepted_scientific_name",
                "acceptedScientificName",
                "scientific_name",
                "scientificName",
            )
        ) or scientific_name

        rank = self._normalize_rank(
            self._first_value(
                raw,
                "taxon_rank",
                "taxonRank",
                "rank",
            )
        )

        if rank == "unknown":
            rank = self._infer_rank(
                canonical_name
            )

        status = self._normalize_status(
            self._first_value(
                raw,
                "taxonomic_status",
                "taxonomicStatus",
                "status",
                "name_status",
                "nameStatus",
            )
        )

        accepted_provider_id = normalize_space(
            self._first_value(
                raw,
                "accepted_taxon_id",
                "acceptedTaxonId",
                "accepted_taxon_key",
                "acceptedTaxonKey",
                "accepted_aphia_id",
                "acceptedAphiaId",
                "accepted_name_usage_id",
                "acceptedNameUsageID",
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

        lineage = self._extract_lineage(
            raw
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
                    "scientific_name_authorship",
                    "scientificNameAuthorship",
                    "authorship",
                    "authority",
                )
            ),
            kingdom=lineage.get(
                "kingdom",
                "",
            ),
            phylum=lineage.get(
                "phylum",
                "",
            ),
            class_name=lineage.get(
                "class",
                "",
            ),
            order=lineage.get(
                "order",
                "",
            ),
            family=lineage.get(
                "family",
                "",
            ),
            genus=lineage.get(
                "genus",
                "",
            ),
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
                "programme": "obis",
                "reference_only": True,
                "enrichment_only": True,
                "taxon_id": provider_id,
                "aphia_id": normalize_space(
                    self._first_value(
                        raw,
                        "aphia_id",
                        "aphiaId",
                        "aphiaID",
                    )
                ),
                "accepted_taxon_id": accepted_provider_id,
                "lineage": lineage,
                "parent": {
                    "id": normalize_space(
                        self._first_value(
                            raw,
                            "parent_taxon_id",
                            "parentTaxonId",
                            "parent_name_usage_id",
                            "parentNameUsageID",
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
                "occurrence": {
                    "occurrence_id": occurrence_id,
                    "basis_of_record": normalize_space(
                        self._first_value(
                            raw,
                            "basis_of_record",
                            "basisOfRecord",
                        )
                    ),
                    "occurrence_status": normalize_space(
                        self._first_value(
                            raw,
                            "occurrence_status",
                            "occurrenceStatus",
                        )
                    ),
                    "individual_count": self._optional_int(
                        self._first_value(
                            raw,
                            "individual_count",
                            "individualCount",
                        )
                    ),
                    "organism_quantity": self._optional_float(
                        self._first_value(
                            raw,
                            "organism_quantity",
                            "organismQuantity",
                        )
                    ),
                    "organism_quantity_type": normalize_space(
                        self._first_value(
                            raw,
                            "organism_quantity_type",
                            "organismQuantityType",
                        )
                    ),
                    "sex": normalize_space(
                        self._first_value(
                            raw,
                            "sex",
                        )
                    ),
                    "life_stage": normalize_space(
                        self._first_value(
                            raw,
                            "life_stage",
                            "lifeStage",
                        )
                    ),
                    "behavior": normalize_space(
                        self._first_value(
                            raw,
                            "behavior",
                        )
                    ),
                    "establishment_means": normalize_space(
                        self._first_value(
                            raw,
                            "establishment_means",
                            "establishmentMeans",
                        )
                    ),
                    "degree_of_establishment": normalize_space(
                        self._first_value(
                            raw,
                            "degree_of_establishment",
                            "degreeOfEstablishment",
                        )
                    ),
                    "pathway": normalize_space(
                        self._first_value(
                            raw,
                            "pathway",
                        )
                    ),
                },
                "event": {
                    "event_id": normalize_space(
                        self._first_value(
                            raw,
                            "event_id",
                            "eventId",
                            "eventID",
                        )
                    ),
                    "event_date": normalize_space(
                        self._first_value(
                            raw,
                            "event_date",
                            "eventDate",
                        )
                    ),
                    "year": self._optional_int(
                        self._first_value(
                            raw,
                            "year",
                        )
                    ),
                    "month": self._optional_int(
                        self._first_value(
                            raw,
                            "month",
                        )
                    ),
                    "day": self._optional_int(
                        self._first_value(
                            raw,
                            "day",
                        )
                    ),
                    "sampling_protocol": normalize_space(
                        self._first_value(
                            raw,
                            "sampling_protocol",
                            "samplingProtocol",
                        )
                    ),
                    "sampling_effort": normalize_space(
                        self._first_value(
                            raw,
                            "sampling_effort",
                            "samplingEffort",
                        )
                    ),
                    "sample_size_value": self._optional_float(
                        self._first_value(
                            raw,
                            "sample_size_value",
                            "sampleSizeValue",
                        )
                    ),
                    "sample_size_unit": normalize_space(
                        self._first_value(
                            raw,
                            "sample_size_unit",
                            "sampleSizeUnit",
                        )
                    ),
                    "field_number": normalize_space(
                        self._first_value(
                            raw,
                            "field_number",
                            "fieldNumber",
                        )
                    ),
                },
                "location": {
                    "decimal_latitude": self._optional_float(
                        self._first_value(
                            raw,
                            "decimal_latitude",
                            "decimalLatitude",
                            "latitude",
                            "lat",
                        )
                    ),
                    "decimal_longitude": self._optional_float(
                        self._first_value(
                            raw,
                            "decimal_longitude",
                            "decimalLongitude",
                            "longitude",
                            "lon",
                            "lng",
                        )
                    ),
                    "coordinate_uncertainty_m": self._optional_float(
                        self._first_value(
                            raw,
                            "coordinate_uncertainty_in_meters",
                            "coordinateUncertaintyInMeters",
                            "coordinate_uncertainty",
                            "coordinateUncertainty",
                        )
                    ),
                    "minimum_depth_m": self._optional_float(
                        self._first_value(
                            raw,
                            "minimum_depth_in_meters",
                            "minimumDepthInMeters",
                            "minimum_depth",
                            "minimumDepth",
                        )
                    ),
                    "maximum_depth_m": self._optional_float(
                        self._first_value(
                            raw,
                            "maximum_depth_in_meters",
                            "maximumDepthInMeters",
                            "maximum_depth",
                            "maximumDepth",
                        )
                    ),
                    "minimum_elevation_m": self._optional_float(
                        self._first_value(
                            raw,
                            "minimum_elevation_in_meters",
                            "minimumElevationInMeters",
                        )
                    ),
                    "maximum_elevation_m": self._optional_float(
                        self._first_value(
                            raw,
                            "maximum_elevation_in_meters",
                            "maximumElevationInMeters",
                        )
                    ),
                    "water_body": normalize_space(
                        self._first_value(
                            raw,
                            "water_body",
                            "waterBody",
                        )
                    ),
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
                    "locality": normalize_space(
                        self._first_value(
                            raw,
                            "locality",
                        )
                    ),
                    "location_id": normalize_space(
                        self._first_value(
                            raw,
                            "location_id",
                            "locationId",
                            "locationID",
                        )
                    ),
                    "marine_region": self._list_value(
                        self._first_value(
                            raw,
                            "marine_regions",
                            "marineRegions",
                            "marine_region",
                            "marineRegion",
                        )
                    ),
                },
                "environment": {
                    "marine": self._optional_bool(
                        self._first_value(
                            raw,
                            "marine",
                            "is_marine",
                            "isMarine",
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
                    "freshwater": self._optional_bool(
                        self._first_value(
                            raw,
                            "freshwater",
                            "is_freshwater",
                            "isFreshwater",
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
                    "habitat": self._list_value(
                        self._first_value(
                            raw,
                            "habitat",
                            "habitats",
                        )
                    ),
                },
                "dataset": {
                    "dataset_id": normalize_space(
                        self._first_value(
                            raw,
                            "dataset_id",
                            "datasetId",
                            "datasetID",
                        )
                    ),
                    "dataset_name": normalize_space(
                        self._first_value(
                            raw,
                            "dataset_name",
                            "datasetName",
                        )
                    ),
                    "resource_id": normalize_space(
                        self._first_value(
                            raw,
                            "resource_id",
                            "resourceId",
                            "resourceID",
                        )
                    ),
                    "resource_name": normalize_space(
                        self._first_value(
                            raw,
                            "resource_name",
                            "resourceName",
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
                    "catalog_number": normalize_space(
                        self._first_value(
                            raw,
                            "catalog_number",
                            "catalogNumber",
                        )
                    ),
                },
                "recorded_by": self._list_value(
                    self._first_value(
                        raw,
                        "recorded_by",
                        "recordedBy",
                        "collectors",
                    )
                ),
                "identified_by": self._list_value(
                    self._first_value(
                        raw,
                        "identified_by",
                        "identifiedBy",
                        "identifiers",
                    )
                ),
                "identification": {
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
                    "identification_verification_status": normalize_space(
                        self._first_value(
                            raw,
                            "identification_verification_status",
                            "identificationVerificationStatus",
                        )
                    ),
                    "type_status": normalize_space(
                        self._first_value(
                            raw,
                            "type_status",
                            "typeStatus",
                        )
                    ),
                },
                "quality": {
                    "quality_flags": self._normalize_quality_flags(
                        self._first_value(
                            raw,
                            "quality_flags",
                            "qualityFlags",
                            "flags",
                        )
                    ),
                    "absence": self._optional_bool(
                        self._first_value(
                            raw,
                            "absence",
                            "is_absence",
                            "isAbsence",
                        )
                    ),
                    "dropped": self._optional_bool(
                        self._first_value(
                            raw,
                            "dropped",
                            "is_dropped",
                            "isDropped",
                        )
                    ),
                    "coordinate_valid": self._optional_bool(
                        self._first_value(
                            raw,
                            "coordinate_valid",
                            "coordinateValid",
                        )
                    ),
                    "depth_valid": self._optional_bool(
                        self._first_value(
                            raw,
                            "depth_valid",
                            "depthValid",
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
                        "external_identifiers",
                        "externalIdentifiers",
                        "taxon_identifiers",
                        "taxonIdentifiers",
                    )
                ),
                "references": self._normalize_references(
                    self._first_value(
                        raw,
                        "references",
                        "reference",
                        "bibliography",
                    )
                ),
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
                "bulk_source": source_path.as_posix(),
                "raw": raw,
            },
        )

    @classmethod
    def _extract_lineage(
        cls,
        raw: Mapping[str, Any],
    ) -> dict[str, str]:
        """Extract major taxonomic lineage values."""

        lineage = {
            "kingdom": normalize_space(
                raw.get(
                    "kingdom"
                )
            ),
            "phylum": normalize_space(
                raw.get(
                    "phylum"
                )
            ),
            "class": normalize_space(
                raw.get(
                    "class"
                )
            ),
            "order": normalize_space(
                raw.get(
                    "order"
                )
            ),
            "family": normalize_space(
                raw.get(
                    "family"
                )
            ),
            "genus": normalize_space(
                raw.get(
                    "genus"
                )
            ),
            "species": normalize_space(
                raw.get(
                    "species"
                )
            ),
        }

        lineage_value = cls._first_value(
            raw,
            "lineage",
            "classification",
            "higher_taxa",
            "higherTaxa",
        )

        for item in cls._list_value(
            lineage_value
        ):
            if not isinstance(
                item,
                Mapping,
            ):
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

            if rank and name and not lineage.get(
                rank
            ):
                lineage[
                    rank
                ] = name

        return lineage

    @classmethod
    def _extract_synonyms(
        cls,
        raw: Mapping[str, Any],
        *,
        scientific_name: str,
        canonical_name: str,
    ) -> list[str]:
        """Extract and deduplicate synonym-like scientific names."""

        values = cls._list_value(
            cls._first_value(
                raw,
                "synonyms",
                "synonym",
                "alternative_names",
                "alternativeNames",
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

        for item in values:
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

    @classmethod
    def _normalize_quality_flags(
        cls,
        value: Any,
    ) -> list[str]:
        """Normalize OBIS quality-control flags."""

        if isinstance(
            value,
            str,
        ):
            values = [
                item
                for item in value.replace(
                    ";",
                    ",",
                ).split(
                    ","
                )
                if item
            ]
        else:
            values = cls._list_value(
                value
            )

        result: list[str] = []
        seen: set[str] = set()

        for item in values:
            normalized = normalize_space(
                item
            ).casefold().replace(
                " ",
                "_",
            )

            if (
                not normalized
                or normalized in seen
            ):
                continue

            seen.add(
                normalized
            )
            result.append(
                normalized
            )

        return result

    @classmethod
    def _normalize_media(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize images, audio, video, and other media objects."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(
            value
        ):
            if isinstance(
                item,
                Mapping,
            ):
                entry = dict(
                    item
                )

                entry.update(
                    {
                        "url": normalize_space(
                            cls._first_value(
                                item,
                                "url",
                                "identifier",
                                "media_url",
                                "mediaUrl",
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
                                "name",
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
                    "url": normalize_space(
                        item
                    ),
                    "type": "",
                    "title": "",
                    "creator": "",
                    "license": "",
                }

            if entry.get(
                "url"
            ):
                result.append(
                    entry
                )

        return result

    @classmethod
    def _normalize_identifiers(
        cls,
        value: Any,
    ) -> list[dict[str, str]]:
        """Normalize external taxonomic and occurrence identifiers."""

        result: list[dict[str, str]] = []

        for item in cls._list_value(
            value
        ):
            if isinstance(
                item,
                Mapping,
            ):
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
                identifier = normalize_space(
                    item
                )
                source = ""

            if identifier:
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
        """Normalize OBIS references and citations."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(
            value
        ):
            if isinstance(
                item,
                Mapping,
            ):
                entry = dict(
                    item
                )

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

                result.append(
                    entry
                )
            else:
                citation = normalize_space(
                    item
                )

                if citation:
                    result.append(
                        {
                            "citation": citation,
                            "doi": "",
                            "url": "",
                        }
                    )

        return result

    @staticmethod
    def _normalize_rank(
        value: Any,
    ) -> str:
        """Normalize taxonomic rank labels."""

        rank = normalize_space(
            value
        ).casefold().replace(
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
        }

        if not rank:
            return "unknown"

        return aliases.get(
            rank,
            rank.replace(
                " ",
                "_",
            ),
        )

    @staticmethod
    def _normalize_status(
        value: Any,
    ) -> str:
        """Normalize taxonomic status labels."""

        status = normalize_space(
            value
        ).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "valid",
            "synonym": "synonym",
            "unaccepted": "synonym",
            "misapplied": "misapplied",
            "alternate representation": "reference",
            "interim unpublished": "provisionally accepted",
            "uncertain": "unknown",
            "unresolved": "unknown",
            "reference": "reference",
        }

        return aliases.get(
            status,
            status or "reference",
        )

    @staticmethod
    def _infer_rank(
        scientific_name: str,
    ) -> str:
        """Infer rank from scientific-name structure."""

        words = normalize_space(
            scientific_name
        ).split()

        if len(words) == 2:
            return "species"

        if len(words) >= 3:
            return "subspecies"

        return "unknown"

    @staticmethod
    def _decode_cursor(
        cursor: str | None,
    ) -> int:
        """Decode a non-negative JSONL line offset."""

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
                f"Invalid OBIS cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "OBIS cursor must be non-negative."
            )

        return offset

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
    def _optional_int(
        value: Any,
    ) -> int | None:
        if value in (
            None,
            "",
        ):
            return None

        try:
            return int(
                value
            )
        except (
            TypeError,
            ValueError,
        ):
            return None

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

    @staticmethod
    def _optional_bool(
        value: Any,
    ) -> bool | None:
        if isinstance(
            value,
            bool,
        ):
            return value

        if isinstance(
            value,
            int,
        ):
            return bool(
                value
            )

        normalized = normalize_space(
            value
        ).casefold()

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
