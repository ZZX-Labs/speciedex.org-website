#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/idigbio.py

Integrated Digitized Biocollections (iDigBio) provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It is intended for specimen, occurrence, collection,
institution, taxonomy, event, locality, georeferencing, identification, media,
genetic-resource, data-quality, reference, rights, and provenance metadata.

Each source record is normalized into the shared Speciedex Taxon contract while
the complete iDigBio source object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "idigbio",
        "path": "static/data/providers/idigbio/records.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "iDigBio",
        "source_url": "https://www.idigbio.org/portal/records/"
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
    """File-backed iDigBio provider."""

    PROVIDER_NAME = "idigbio"

    DEFAULT_SOURCE_NAME = "iDigBio"
    DEFAULT_SOURCE_URL = "https://www.idigbio.org/portal/records/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable iDigBio JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"iDigBio export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"iDigBio path is not a file: {source_path}"
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
                            f"Invalid iDigBio JSON at "
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
        """Resolve the configured iDigBio JSONL source path."""

        configured = normalize_space(
            self.definition.get("path")
            or self.definition.get("file")
            or self.definition.get("source_path")
        )

        if not configured:
            raise ProviderError(
                "iDigBio provider requires a path."
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
        """Normalize one iDigBio specimen or occurrence record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "uuid",
                "idigbio_uuid",
                "idigbioUuid",
                "occurrence_id",
                "occurrenceId",
                "occurrenceID",
                "catalog_number",
                "catalogNumber",
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

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "accepted_name_usage",
                "acceptedNameUsage",
                "verbatim_scientific_name",
                "verbatimScientificName",
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
                "verbatim_taxon_rank",
                "verbatimTaxonRank",
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
                "occurrence_status",
                "occurrenceStatus",
            )
        )

        accepted_provider_id = normalize_space(
            self._first_value(
                raw,
                "accepted_name_usage_id",
                "acceptedNameUsageID",
                "accepted_taxon_id",
                "acceptedTaxonId",
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
                "references",
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
                + "/"
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
                "programme": "idigbio",
                "reference_only": True,
                "idigbio_uuid": provider_id,
                "lineage": lineage,
                "occurrence": {
                    "occurrence_id": normalize_space(
                        self._first_value(
                            raw,
                            "occurrence_id",
                            "occurrenceId",
                            "occurrenceID",
                        )
                    ),
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
                        self._first_value(raw, "sex")
                    ),
                    "life_stage": normalize_space(
                        self._first_value(
                            raw,
                            "life_stage",
                            "lifeStage",
                        )
                    ),
                    "reproductive_condition": normalize_space(
                        self._first_value(
                            raw,
                            "reproductive_condition",
                            "reproductiveCondition",
                        )
                    ),
                    "behavior": normalize_space(
                        self._first_value(raw, "behavior")
                    ),
                    "establishment_means": normalize_space(
                        self._first_value(
                            raw,
                            "establishment_means",
                            "establishmentMeans",
                        )
                    ),
                    "recorded_by": normalize_space(
                        self._first_value(
                            raw,
                            "recorded_by",
                            "recordedBy",
                            "collector",
                        )
                    ),
                    "recorded_by_id": normalize_space(
                        self._first_value(
                            raw,
                            "recorded_by_id",
                            "recordedByID",
                        )
                    ),
                    "occurrence_remarks": normalize_space(
                        self._first_value(
                            raw,
                            "occurrence_remarks",
                            "occurrenceRemarks",
                        )
                    ),
                },
                "collection": {
                    "institution_id": normalize_space(
                        self._first_value(
                            raw,
                            "institution_id",
                            "institutionID",
                        )
                    ),
                    "institution_code": normalize_space(
                        self._first_value(
                            raw,
                            "institution_code",
                            "institutionCode",
                        )
                    ),
                    "collection_id": normalize_space(
                        self._first_value(
                            raw,
                            "collection_id",
                            "collectionID",
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
                    "dataset_id": normalize_space(
                        self._first_value(
                            raw,
                            "dataset_id",
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
                    "material_sample_id": normalize_space(
                        self._first_value(
                            raw,
                            "material_sample_id",
                            "materialSampleID",
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
                    "parent_event_id": normalize_space(
                        self._first_value(
                            raw,
                            "parent_event_id",
                            "parentEventID",
                        )
                    ),
                    "event_date": normalize_space(
                        self._first_value(
                            raw,
                            "event_date",
                            "eventDate",
                        )
                    ),
                    "event_time": normalize_space(
                        self._first_value(
                            raw,
                            "event_time",
                            "eventTime",
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
                    "verbatim_event_date": normalize_space(
                        self._first_value(
                            raw,
                            "verbatim_event_date",
                            "verbatimEventDate",
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
                    "field_number": normalize_space(
                        self._first_value(
                            raw,
                            "field_number",
                            "fieldNumber",
                        )
                    ),
                    "field_notes": normalize_space(
                        self._first_value(
                            raw,
                            "field_notes",
                            "fieldNotes",
                        )
                    ),
                    "habitat": normalize_space(
                        self._first_value(raw, "habitat")
                    ),
                },
                "location": {
                    "location_id": normalize_space(
                        self._first_value(
                            raw,
                            "location_id",
                            "locationID",
                        )
                    ),
                    "higher_geography": normalize_space(
                        self._first_value(
                            raw,
                            "higher_geography",
                            "higherGeography",
                        )
                    ),
                    "continent": normalize_space(
                        self._first_value(raw, "continent")
                    ),
                    "water_body": normalize_space(
                        self._first_value(
                            raw,
                            "water_body",
                            "waterBody",
                        )
                    ),
                    "island_group": normalize_space(
                        self._first_value(
                            raw,
                            "island_group",
                            "islandGroup",
                        )
                    ),
                    "island": normalize_space(
                        self._first_value(raw, "island")
                    ),
                    "country": normalize_space(
                        self._first_value(raw, "country")
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
                        self._first_value(raw, "locality")
                    ),
                    "verbatim_locality": normalize_space(
                        self._first_value(
                            raw,
                            "verbatim_locality",
                            "verbatimLocality",
                        )
                    ),
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
                    "minimum_elevation_m": self._optional_float(
                        self._first_value(
                            raw,
                            "minimum_elevation_m",
                            "minimumElevationInMeters",
                        )
                    ),
                    "maximum_elevation_m": self._optional_float(
                        self._first_value(
                            raw,
                            "maximum_elevation_m",
                            "maximumElevationInMeters",
                        )
                    ),
                    "minimum_depth_m": self._optional_float(
                        self._first_value(
                            raw,
                            "minimum_depth_m",
                            "minimumDepthInMeters",
                        )
                    ),
                    "maximum_depth_m": self._optional_float(
                        self._first_value(
                            raw,
                            "maximum_depth_m",
                            "maximumDepthInMeters",
                        )
                    ),
                },
                "georeference": {
                    "georeferenced_by": normalize_space(
                        self._first_value(
                            raw,
                            "georeferenced_by",
                            "georeferencedBy",
                        )
                    ),
                    "georeferenced_date": normalize_space(
                        self._first_value(
                            raw,
                            "georeferenced_date",
                            "georeferencedDate",
                        )
                    ),
                    "georeference_protocol": normalize_space(
                        self._first_value(
                            raw,
                            "georeference_protocol",
                            "georeferenceProtocol",
                        )
                    ),
                    "georeference_sources": normalize_space(
                        self._first_value(
                            raw,
                            "georeference_sources",
                            "georeferenceSources",
                        )
                    ),
                    "verification_status": normalize_space(
                        self._first_value(
                            raw,
                            "georeference_verification_status",
                            "georeferenceVerificationStatus",
                        )
                    ),
                    "remarks": normalize_space(
                        self._first_value(
                            raw,
                            "georeference_remarks",
                            "georeferenceRemarks",
                        )
                    ),
                },
                "identification": {
                    "identification_id": normalize_space(
                        self._first_value(
                            raw,
                            "identification_id",
                            "identificationID",
                        )
                    ),
                    "identified_by": normalize_space(
                        self._first_value(
                            raw,
                            "identified_by",
                            "identifiedBy",
                        )
                    ),
                    "identified_by_id": normalize_space(
                        self._first_value(
                            raw,
                            "identified_by_id",
                            "identifiedByID",
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
                    "type_status": normalize_space(
                        self._first_value(
                            raw,
                            "type_status",
                            "typeStatus",
                        )
                    ),
                    "verification_status": normalize_space(
                        self._first_value(
                            raw,
                            "identification_verification_status",
                            "identificationVerificationStatus",
                        )
                    ),
                    "identification_references": normalize_space(
                        self._first_value(
                            raw,
                            "identification_references",
                            "identificationReferences",
                        )
                    ),
                    "identification_remarks": normalize_space(
                        self._first_value(
                            raw,
                            "identification_remarks",
                            "identificationRemarks",
                        )
                    ),
                    "verbatim_identification": normalize_space(
                        self._first_value(
                            raw,
                            "verbatim_identification",
                            "verbatimIdentification",
                        )
                    ),
                },
                "taxonomy": {
                    "taxon_id": normalize_space(
                        self._first_value(
                            raw,
                            "taxon_id",
                            "taxonID",
                        )
                    ),
                    "scientific_name_id": normalize_space(
                        self._first_value(
                            raw,
                            "scientific_name_id",
                            "scientificNameID",
                        )
                    ),
                    "name_according_to": normalize_space(
                        self._first_value(
                            raw,
                            "name_according_to",
                            "nameAccordingTo",
                        )
                    ),
                    "name_published_in": normalize_space(
                        self._first_value(
                            raw,
                            "name_published_in",
                            "namePublishedIn",
                        )
                    ),
                    "nomenclatural_code": normalize_space(
                        self._first_value(
                            raw,
                            "nomenclatural_code",
                            "nomenclaturalCode",
                        )
                    ),
                    "taxon_remarks": normalize_space(
                        self._first_value(
                            raw,
                            "taxon_remarks",
                            "taxonRemarks",
                        )
                    ),
                },
                "genetic_resources": {
                    "associated_sequences": self._normalize_sequence_links(
                        self._first_value(
                            raw,
                            "associated_sequences",
                            "associatedSequences",
                            "sequence_accessions",
                            "sequenceAccessions",
                        )
                    ),
                    "genetic_accession_numbers": self._normalize_sequence_links(
                        self._first_value(
                            raw,
                            "genetic_accession_numbers",
                            "geneticAccessionNumbers",
                        )
                    ),
                    "biosample_accession": normalize_space(
                        self._first_value(
                            raw,
                            "biosample_accession",
                            "biosampleAccession",
                        )
                    ),
                    "bioproject_accession": normalize_space(
                        self._first_value(
                            raw,
                            "bioproject_accession",
                            "bioprojectAccession",
                        )
                    ),
                },
                "media": self._normalize_media(
                    self._first_value(
                        raw,
                        "media",
                        "images",
                        "image",
                        "associated_media",
                        "associatedMedia",
                    )
                ),
                "quality": {
                    "flags": self._list_value(
                        self._first_value(
                            raw,
                            "flags",
                            "quality_flags",
                            "qualityFlags",
                            "data_quality_flags",
                            "dataQualityFlags",
                        )
                    ),
                    "issues": self._list_value(
                        self._first_value(
                            raw,
                            "issues",
                            "quality_issues",
                            "qualityIssues",
                        )
                    ),
                    "coordinate_valid": self._optional_bool(
                        self._first_value(
                            raw,
                            "coordinate_valid",
                            "coordinateValid",
                        )
                    ),
                    "taxon_match_status": normalize_space(
                        self._first_value(
                            raw,
                            "taxon_match_status",
                            "taxonMatchStatus",
                        )
                    ),
                    "recordset_version": normalize_space(
                        self._first_value(
                            raw,
                            "recordset_version",
                            "recordsetVersion",
                        )
                    ),
                },
                "recordset": {
                    "recordset_id": normalize_space(
                        self._first_value(
                            raw,
                            "recordset_id",
                            "recordsetId",
                            "recordset",
                        )
                    ),
                    "recordset_name": normalize_space(
                        self._first_value(
                            raw,
                            "recordset_name",
                            "recordsetName",
                        )
                    ),
                    "publisher": normalize_space(
                        self._first_value(
                            raw,
                            "publisher",
                        )
                    ),
                    "source_record_id": normalize_space(
                        self._first_value(
                            raw,
                            "source_record_id",
                            "sourceRecordId",
                        )
                    ),
                },
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
                    "access_rights": normalize_space(
                        self._first_value(
                            raw,
                            "access_rights",
                            "accessRights",
                        )
                    ),
                    "bibliographic_citation": normalize_space(
                        self._first_value(
                            raw,
                            "bibliographic_citation",
                            "bibliographicCitation",
                        )
                    ),
                    "information_withheld": normalize_space(
                        self._first_value(
                            raw,
                            "information_withheld",
                            "informationWithheld",
                        )
                    ),
                    "data_generalizations": normalize_space(
                        self._first_value(
                            raw,
                            "data_generalizations",
                            "dataGeneralizations",
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
                        "references_list",
                        "referencesList",
                        "associated_references",
                        "associatedReferences",
                        "references",
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
        """Extract Darwin Core-style classification."""

        lineage = {
            "kingdom": normalize_space(raw.get("kingdom")),
            "phylum": normalize_space(raw.get("phylum")),
            "class": normalize_space(raw.get("class")),
            "order": normalize_space(raw.get("order")),
            "family": normalize_space(raw.get("family")),
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
        """Extract and deduplicate synonyms."""

        values = cls._list_value(
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
        seen: set[str] = set(excluded)

        for item in values:
            name = normalize_space(
                cls._first_value(
                    item,
                    "scientific_name",
                    "scientificName",
                    "name",
                )
                if isinstance(item, Mapping)
                else item
            )
            key = name.casefold()

            if not name or key in seen:
                continue

            seen.add(key)
            result.append(name)

        return result

    @classmethod
    def _normalize_media(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize specimen images, audio, and other media."""

        result: list[dict[str, Any]] = []

        for item in cls._split_values(value):
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
    def _normalize_sequence_links(
        cls,
        value: Any,
    ) -> list[dict[str, str]]:
        """Normalize associated sequence accessions and links."""

        result: list[dict[str, str]] = []

        for item in cls._split_values(value):
            if isinstance(item, Mapping):
                accession = normalize_space(
                    cls._first_value(
                        item,
                        "accession",
                        "identifier",
                        "id",
                        "value",
                    )
                )
                database = normalize_space(
                    cls._first_value(
                        item,
                        "database",
                        "source",
                        "namespace",
                    )
                )
                url = normalize_space(
                    cls._first_value(
                        item,
                        "url",
                        "href",
                    )
                )
            else:
                text = normalize_space(item)

                if text.startswith(("http://", "https://")):
                    accession = ""
                    database = ""
                    url = text
                else:
                    database, separator, accession = text.partition(":")

                    if not separator:
                        database = ""
                        accession = text

                    url = ""

            if accession or url:
                result.append(
                    {
                        "accession": accession,
                        "database": database,
                        "url": url,
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
        """Normalize iDigBio and external identifiers."""

        result: list[dict[str, str]] = []

        for item in cls._split_values(value):
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
            "uuid": "iDigBio",
            "idigbio_uuid": "iDigBio",
            "idigbioUuid": "iDigBio",
            "gbif_id": "GBIF",
            "gbifId": "GBIF",
            "itis_tsn": "ITIS",
            "itisTsn": "ITIS",
            "taxon_id": "Darwin Core taxonID",
            "taxonID": "Darwin Core taxonID",
            "scientific_name_id": "Darwin Core scientificNameID",
            "scientificNameID": "Darwin Core scientificNameID",
            "biosample_accession": "BioSample",
            "biosampleAccession": "BioSample",
            "bioproject_accession": "BioProject",
            "bioprojectAccession": "BioProject",
            "ncbi_taxid": "NCBI Taxonomy",
            "ncbiTaxid": "NCBI Taxonomy",
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
        """Normalize associated references."""

        result: list[dict[str, Any]] = []

        for item in cls._split_values(value):
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
                            "doi": "",
                            "url": citation
                            if citation.startswith(("http://", "https://"))
                            else "",
                            "raw": item,
                        }
                    )

        return result

    @staticmethod
    def _normalize_rank(value: Any) -> str:
        """Normalize Darwin Core taxonomic ranks."""

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
        """Normalize taxonomic and occurrence status values."""

        status = normalize_space(value).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "valid",
            "current": "accepted",
            "present": "accepted",
            "synonym": "synonym",
            "unaccepted": "synonym",
            "misapplied": "misapplied",
            "absent": "inactive",
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

        if "var." in lowered or "variety" in lowered:
            return "variety"

        if "f." in lowered or "forma" in lowered:
            return "form"

        if len(words) == 2:
            return "species"

        if len(words) >= 3:
            return "infraspecific"

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
                f"Invalid iDigBio cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "iDigBio cursor must be non-negative."
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

    @classmethod
    def _split_values(
        cls,
        value: Any,
    ) -> list[Any]:
        """Split pipe- and semicolon-delimited string collections."""

        result: list[Any] = []

        for item in cls._list_value(value):
            if isinstance(item, str):
                parts = [item]

                for separator in ("|", ";"):
                    expanded: list[str] = []

                    for part in parts:
                        expanded.extend(part.split(separator))

                    parts = expanded

                result.extend(
                    part.strip()
                    for part in parts
                    if part.strip()
                )
            else:
                result.append(item)

        return result

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
            "valid",
            "present",
        }:
            return True

        if normalized in {
            "0",
            "false",
            "no",
            "n",
            "invalid",
            "absent",
        }:
            return False

        return None
