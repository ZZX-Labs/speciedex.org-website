#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/ena.py

European Nucleotide Archive (ENA) provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It is intended for nucleotide-sequence, taxonomic,
sample, study, experiment, run, analysis, assembly, submission, geographic,
environmental, bibliographic, and provenance metadata.

Each source record is normalized into the shared Speciedex Taxon contract while
the complete ENA source object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "ena",
        "path": "static/data/providers/ena/records.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "European Nucleotide Archive",
        "source_url": "https://www.ebi.ac.uk/ena/browser/"
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
    """File-backed European Nucleotide Archive provider."""

    PROVIDER_NAME = "ena"

    DEFAULT_SOURCE_NAME = "European Nucleotide Archive"
    DEFAULT_SOURCE_URL = "https://www.ebi.ac.uk/ena/browser/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable ENA JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"ENA export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"ENA path is not a file: {source_path}"
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
                            f"Invalid ENA JSON at "
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
                "ENA provider requires a path."
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
        provider_id = normalize_space(
            self._first_value(
                raw,
                "accession",
                "primary_accession",
                "primaryAccession",
                "sample_accession",
                "sampleAccession",
                "study_accession",
                "studyAccession",
                "run_accession",
                "runAccession",
                "experiment_accession",
                "experimentAccession",
                "analysis_accession",
                "analysisAccession",
                "assembly_accession",
                "assemblyAccession",
                "submission_accession",
                "submissionAccession",
                "id",
            )
        )

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "organism",
                "organism_name",
                "organismName",
                "taxon_name",
                "taxonName",
                "species",
            )
        )

        if not provider_id or not scientific_name:
            return None

        canonical_name = normalize_space(
            self._first_value(
                raw,
                "canonical_name",
                "canonicalName",
                "species",
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
                "record_status",
                "recordStatus",
            )
        )

        accepted_provider_id = normalize_space(
            self._first_value(
                raw,
                "accepted_taxon_id",
                "acceptedTaxonId",
                "accepted_name_id",
                "acceptedNameId",
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
            source_url = (
                normalize_space(
                    self.definition.get(
                        "source_url",
                        self.DEFAULT_SOURCE_URL,
                    )
                ).rstrip("/")
                + "/view/"
                + provider_id
            )

        lineage = self._extract_lineage(raw)

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
            kingdom=lineage.get(
                "kingdom",
                lineage.get("domain", ""),
            ),
            phylum=lineage.get("phylum", ""),
            class_name=lineage.get("class", ""),
            order=lineage.get("order", ""),
            family=lineage.get("family", ""),
            genus=lineage.get("genus", ""),
            accepted_provider_id=accepted_provider_id,
            source_url=source_url,
            source_modified=normalize_space(
                self._first_value(
                    raw,
                    "last_updated",
                    "lastUpdated",
                    "modified",
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
                "programme": "ena",
                "reference_only": True,
                "accession": provider_id,
                "lineage": lineage,
                "taxonomy": {
                    "tax_id": normalize_space(
                        self._first_value(
                            raw,
                            "tax_id",
                            "taxId",
                            "taxon_id",
                            "taxonId",
                            "ncbi_taxid",
                            "ncbiTaxid",
                        )
                    ),
                    "common_name": normalize_space(
                        self._first_value(
                            raw,
                            "common_name",
                            "commonName",
                        )
                    ),
                    "strain": normalize_space(
                        self._first_value(
                            raw,
                            "strain",
                            "strain_name",
                            "strainName",
                        )
                    ),
                    "subspecies": normalize_space(
                        self._first_value(
                            raw,
                            "subspecies",
                        )
                    ),
                    "isolate": normalize_space(
                        self._first_value(
                            raw,
                            "isolate",
                            "isolate_name",
                            "isolateName",
                        )
                    ),
                    "serovar": normalize_space(
                        self._first_value(raw, "serovar")
                    ),
                    "cultivar": normalize_space(
                        self._first_value(raw, "cultivar")
                    ),
                    "breed": normalize_space(
                        self._first_value(raw, "breed")
                    ),
                    "ecotype": normalize_space(
                        self._first_value(raw, "ecotype")
                    ),
                    "bio_material": normalize_space(
                        self._first_value(
                            raw,
                            "bio_material",
                            "bioMaterial",
                        )
                    ),
                },
                "record": {
                    "record_type": normalize_space(
                        self._first_value(
                            raw,
                            "record_type",
                            "recordType",
                            "result_type",
                            "resultType",
                        )
                    ),
                    "primary_accession": normalize_space(
                        self._first_value(
                            raw,
                            "primary_accession",
                            "primaryAccession",
                            "accession",
                        )
                    ),
                    "secondary_accessions": self._normalize_accessions(
                        self._first_value(
                            raw,
                            "secondary_accessions",
                            "secondaryAccessions",
                            "secondary_accession",
                            "secondaryAccession",
                        )
                    ),
                    "version": normalize_space(
                        self._first_value(
                            raw,
                            "version",
                            "accession_version",
                            "accessionVersion",
                        )
                    ),
                    "description": normalize_space(
                        self._first_value(
                            raw,
                            "description",
                            "title",
                            "record_title",
                            "recordTitle",
                        )
                    ),
                    "first_public": normalize_space(
                        self._first_value(
                            raw,
                            "first_public",
                            "firstPublic",
                            "first_publication_date",
                            "firstPublicationDate",
                        )
                    ),
                    "last_updated": normalize_space(
                        self._first_value(
                            raw,
                            "last_updated",
                            "lastUpdated",
                        )
                    ),
                    "release": normalize_space(
                        self._first_value(
                            raw,
                            "release",
                            "release_version",
                            "releaseVersion",
                        )
                    ),
                },
                "study": {
                    "study_accession": normalize_space(
                        self._first_value(
                            raw,
                            "study_accession",
                            "studyAccession",
                            "project_accession",
                            "projectAccession",
                        )
                    ),
                    "study_title": normalize_space(
                        self._first_value(
                            raw,
                            "study_title",
                            "studyTitle",
                            "project_title",
                            "projectTitle",
                        )
                    ),
                    "study_description": normalize_space(
                        self._first_value(
                            raw,
                            "study_description",
                            "studyDescription",
                        )
                    ),
                    "center_name": normalize_space(
                        self._first_value(
                            raw,
                            "center_name",
                            "centerName",
                        )
                    ),
                },
                "sample": {
                    "sample_accession": normalize_space(
                        self._first_value(
                            raw,
                            "sample_accession",
                            "sampleAccession",
                            "biosample_accession",
                            "biosampleAccession",
                        )
                    ),
                    "sample_alias": normalize_space(
                        self._first_value(
                            raw,
                            "sample_alias",
                            "sampleAlias",
                        )
                    ),
                    "sample_title": normalize_space(
                        self._first_value(
                            raw,
                            "sample_title",
                            "sampleTitle",
                        )
                    ),
                    "sample_description": normalize_space(
                        self._first_value(
                            raw,
                            "sample_description",
                            "sampleDescription",
                        )
                    ),
                    "sample_attributes": self._normalize_attributes(
                        self._first_value(
                            raw,
                            "sample_attributes",
                            "sampleAttributes",
                            "attributes",
                        )
                    ),
                },
                "experiment": {
                    "experiment_accession": normalize_space(
                        self._first_value(
                            raw,
                            "experiment_accession",
                            "experimentAccession",
                        )
                    ),
                    "experiment_title": normalize_space(
                        self._first_value(
                            raw,
                            "experiment_title",
                            "experimentTitle",
                        )
                    ),
                    "library_name": normalize_space(
                        self._first_value(
                            raw,
                            "library_name",
                            "libraryName",
                        )
                    ),
                    "library_strategy": normalize_space(
                        self._first_value(
                            raw,
                            "library_strategy",
                            "libraryStrategy",
                        )
                    ),
                    "library_source": normalize_space(
                        self._first_value(
                            raw,
                            "library_source",
                            "librarySource",
                        )
                    ),
                    "library_selection": normalize_space(
                        self._first_value(
                            raw,
                            "library_selection",
                            "librarySelection",
                        )
                    ),
                    "library_layout": normalize_space(
                        self._first_value(
                            raw,
                            "library_layout",
                            "libraryLayout",
                        )
                    ),
                    "instrument_platform": normalize_space(
                        self._first_value(
                            raw,
                            "instrument_platform",
                            "instrumentPlatform",
                            "platform",
                        )
                    ),
                    "instrument_model": normalize_space(
                        self._first_value(
                            raw,
                            "instrument_model",
                            "instrumentModel",
                        )
                    ),
                },
                "run": {
                    "run_accession": normalize_space(
                        self._first_value(
                            raw,
                            "run_accession",
                            "runAccession",
                        )
                    ),
                    "run_alias": normalize_space(
                        self._first_value(
                            raw,
                            "run_alias",
                            "runAlias",
                        )
                    ),
                    "read_count": self._optional_int(
                        self._first_value(
                            raw,
                            "read_count",
                            "readCount",
                        )
                    ),
                    "base_count": self._optional_int(
                        self._first_value(
                            raw,
                            "base_count",
                            "baseCount",
                        )
                    ),
                    "fastq_bytes": self._optional_int(
                        self._first_value(
                            raw,
                            "fastq_bytes",
                            "fastqBytes",
                        )
                    ),
                    "submitted_bytes": self._optional_int(
                        self._first_value(
                            raw,
                            "submitted_bytes",
                            "submittedBytes",
                        )
                    ),
                    "files": self._normalize_files(
                        self._first_value(
                            raw,
                            "files",
                            "run_files",
                            "runFiles",
                        )
                    ),
                },
                "sequence": {
                    "sequence_accessions": self._normalize_accessions(
                        self._first_value(
                            raw,
                            "sequence_accessions",
                            "sequenceAccessions",
                            "sequence_accession",
                            "sequenceAccession",
                        )
                    ),
                    "molecule_type": normalize_space(
                        self._first_value(
                            raw,
                            "molecule_type",
                            "moleculeType",
                        )
                    ),
                    "sequence_length": self._optional_int(
                        self._first_value(
                            raw,
                            "sequence_length",
                            "sequenceLength",
                            "base_count",
                            "baseCount",
                        )
                    ),
                    "topology": normalize_space(
                        self._first_value(
                            raw,
                            "topology",
                        )
                    ),
                    "completeness": normalize_space(
                        self._first_value(
                            raw,
                            "completeness",
                            "sequence_completeness",
                            "sequenceCompleteness",
                        )
                    ),
                    "sequence_version": normalize_space(
                        self._first_value(
                            raw,
                            "sequence_version",
                            "sequenceVersion",
                        )
                    ),
                    "gc_content_percent": self._optional_float(
                        self._first_value(
                            raw,
                            "gc_content",
                            "gcContent",
                            "gc_content_percent",
                            "gcContentPercent",
                        )
                    ),
                },
                "assembly": {
                    "assembly_accession": normalize_space(
                        self._first_value(
                            raw,
                            "assembly_accession",
                            "assemblyAccession",
                        )
                    ),
                    "assembly_name": normalize_space(
                        self._first_value(
                            raw,
                            "assembly_name",
                            "assemblyName",
                        )
                    ),
                    "assembly_type": normalize_space(
                        self._first_value(
                            raw,
                            "assembly_type",
                            "assemblyType",
                        )
                    ),
                    "assembly_level": normalize_space(
                        self._first_value(
                            raw,
                            "assembly_level",
                            "assemblyLevel",
                        )
                    ),
                    "assembly_method": normalize_space(
                        self._first_value(
                            raw,
                            "assembly_method",
                            "assemblyMethod",
                        )
                    ),
                    "coverage": normalize_space(
                        self._first_value(
                            raw,
                            "coverage",
                            "genome_coverage",
                            "genomeCoverage",
                        )
                    ),
                    "contig_count": self._optional_int(
                        self._first_value(
                            raw,
                            "contig_count",
                            "contigCount",
                        )
                    ),
                    "scaffold_count": self._optional_int(
                        self._first_value(
                            raw,
                            "scaffold_count",
                            "scaffoldCount",
                        )
                    ),
                    "total_length": self._optional_int(
                        self._first_value(
                            raw,
                            "total_length",
                            "totalLength",
                            "assembly_length",
                            "assemblyLength",
                        )
                    ),
                    "n50": self._optional_int(
                        self._first_value(
                            raw,
                            "n50",
                            "assembly_n50",
                            "assemblyN50",
                        )
                    ),
                },
                "analysis": {
                    "analysis_accession": normalize_space(
                        self._first_value(
                            raw,
                            "analysis_accession",
                            "analysisAccession",
                        )
                    ),
                    "analysis_type": normalize_space(
                        self._first_value(
                            raw,
                            "analysis_type",
                            "analysisType",
                        )
                    ),
                    "analysis_title": normalize_space(
                        self._first_value(
                            raw,
                            "analysis_title",
                            "analysisTitle",
                        )
                    ),
                    "analysis_description": normalize_space(
                        self._first_value(
                            raw,
                            "analysis_description",
                            "analysisDescription",
                        )
                    ),
                    "pipeline_name": normalize_space(
                        self._first_value(
                            raw,
                            "pipeline_name",
                            "pipelineName",
                        )
                    ),
                    "pipeline_version": normalize_space(
                        self._first_value(
                            raw,
                            "pipeline_version",
                            "pipelineVersion",
                        )
                    ),
                },
                "submission": {
                    "submission_accession": normalize_space(
                        self._first_value(
                            raw,
                            "submission_accession",
                            "submissionAccession",
                        )
                    ),
                    "submission_alias": normalize_space(
                        self._first_value(
                            raw,
                            "submission_alias",
                            "submissionAlias",
                        )
                    ),
                    "broker_name": normalize_space(
                        self._first_value(
                            raw,
                            "broker_name",
                            "brokerName",
                        )
                    ),
                    "submitter": normalize_space(
                        self._first_value(
                            raw,
                            "submitter",
                            "submitter_name",
                            "submitterName",
                        )
                    ),
                    "submission_date": normalize_space(
                        self._first_value(
                            raw,
                            "submission_date",
                            "submissionDate",
                        )
                    ),
                },
                "environment": {
                    "isolation_source": normalize_space(
                        self._first_value(
                            raw,
                            "isolation_source",
                            "isolationSource",
                        )
                    ),
                    "host": normalize_space(
                        self._first_value(
                            raw,
                            "host",
                            "host_name",
                            "hostName",
                        )
                    ),
                    "host_tax_id": normalize_space(
                        self._first_value(
                            raw,
                            "host_tax_id",
                            "hostTaxId",
                        )
                    ),
                    "environment_biome": normalize_space(
                        self._first_value(
                            raw,
                            "environment_biome",
                            "environmentBiome",
                            "env_biome",
                            "envBiome",
                        )
                    ),
                    "environment_feature": normalize_space(
                        self._first_value(
                            raw,
                            "environment_feature",
                            "environmentFeature",
                            "env_feature",
                            "envFeature",
                        )
                    ),
                    "environment_material": normalize_space(
                        self._first_value(
                            raw,
                            "environment_material",
                            "environmentMaterial",
                            "env_material",
                            "envMaterial",
                        )
                    ),
                    "collection_date": normalize_space(
                        self._first_value(
                            raw,
                            "collection_date",
                            "collectionDate",
                        )
                    ),
                    "country": normalize_space(
                        self._first_value(
                            raw,
                            "country",
                            "geo_loc_name",
                            "geoLocName",
                        )
                    ),
                    "latitude": self._optional_float(
                        self._first_value(
                            raw,
                            "latitude",
                            "lat",
                        )
                    ),
                    "longitude": self._optional_float(
                        self._first_value(
                            raw,
                            "longitude",
                            "lon",
                            "lng",
                        )
                    ),
                    "depth_m": self._optional_float(
                        self._first_value(
                            raw,
                            "depth",
                            "depth_m",
                            "depthM",
                        )
                    ),
                    "elevation_m": self._optional_float(
                        self._first_value(
                            raw,
                            "elevation",
                            "elevation_m",
                            "elevationM",
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
                        "publications",
                    )
                ),
                "links": self._normalize_links(
                    self._first_value(
                        raw,
                        "links",
                        "link",
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
    ) -> dict[str, str]:
        lineage = {
            "domain": normalize_space(
                cls._first_value(
                    raw,
                    "domain",
                    "superkingdom",
                )
            ),
            "kingdom": normalize_space(raw.get("kingdom")),
            "phylum": normalize_space(raw.get("phylum")),
            "class": normalize_space(raw.get("class")),
            "order": normalize_space(raw.get("order")),
            "family": normalize_space(raw.get("family")),
            "genus": normalize_space(raw.get("genus")),
            "species": normalize_space(raw.get("species")),
        }

        lineage_value = cls._first_value(
            raw,
            "lineage",
            "classification",
            "taxonomic_lineage",
            "taxonomicLineage",
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

        if not lineage.get("kingdom") and lineage.get("domain"):
            lineage["kingdom"] = lineage["domain"]

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
            value = normalize_space(
                cls._first_value(
                    item,
                    "scientific_name",
                    "scientificName",
                    "name",
                )
                if isinstance(item, Mapping)
                else item
            )
            key = value.casefold()

            if not value or key in seen:
                continue

            seen.add(key)
            result.append(value)

        return result

    @classmethod
    def _normalize_accessions(
        cls,
        value: Any,
    ) -> list[str]:
        result: list[str] = []
        seen: set[str] = set()

        for item in cls._list_value(value):
            if isinstance(item, str):
                parts = item.replace(";", ",").split(",")
            else:
                parts = [item]

            for part in parts:
                accession = normalize_space(part)
                key = accession.casefold()

                if not accession or key in seen:
                    continue

                seen.add(key)
                result.append(accession)

        return result

    @classmethod
    def _normalize_attributes(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        if isinstance(value, Mapping):
            value = [
                {
                    "tag": key,
                    "value": item,
                }
                for key, item in value.items()
            ]

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                result.append(
                    {
                        "tag": normalize_space(
                            cls._first_value(
                                item,
                                "tag",
                                "name",
                                "label",
                            )
                        ),
                        "value": cls._first_value(
                            item,
                            "value",
                            "content",
                        ),
                        "unit": normalize_space(
                            cls._first_value(
                                item,
                                "unit",
                            )
                        ),
                        "raw": dict(item),
                    }
                )

        return result

    @classmethod
    def _normalize_files(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                result.append(
                    {
                        "url": normalize_space(
                            cls._first_value(
                                item,
                                "url",
                                "ftp",
                                "path",
                            )
                        ),
                        "type": normalize_space(
                            cls._first_value(
                                item,
                                "type",
                                "file_type",
                                "fileType",
                                "format",
                            )
                        ),
                        "md5": normalize_space(
                            cls._first_value(
                                item,
                                "md5",
                                "checksum",
                            )
                        ),
                        "size_bytes": cls._optional_int(
                            cls._first_value(
                                item,
                                "size_bytes",
                                "sizeBytes",
                                "size",
                            )
                        ),
                        "raw": dict(item),
                    }
                )
            else:
                url = normalize_space(item)

                if url:
                    result.append(
                        {
                            "url": url,
                            "type": "",
                            "md5": "",
                            "size_bytes": None,
                            "raw": item,
                        }
                    )

        return result

    @classmethod
    def _normalize_links(
        cls,
        value: Any,
    ) -> list[dict[str, str]]:
        result: list[dict[str, str]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                url = normalize_space(
                    cls._first_value(
                        item,
                        "url",
                        "href",
                        "link",
                    )
                )
                relation = normalize_space(
                    cls._first_value(
                        item,
                        "relation",
                        "rel",
                        "type",
                    )
                )
            else:
                url = normalize_space(item)
                relation = ""

            if url:
                result.append(
                    {
                        "url": url,
                        "relation": relation,
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
        result: list[dict[str, str]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                identifier = normalize_space(
                    cls._first_value(
                        item,
                        "identifier",
                        "id",
                        "value",
                        "accession",
                    )
                )
                source = normalize_space(
                    cls._first_value(
                        item,
                        "source",
                        "database",
                        "namespace",
                        "type",
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
            "tax_id": "NCBI Taxonomy",
            "taxId": "NCBI Taxonomy",
            "ncbi_taxid": "NCBI Taxonomy",
            "ncbiTaxid": "NCBI Taxonomy",
            "biosample_accession": "BioSample",
            "biosampleAccession": "BioSample",
            "bioproject_accession": "BioProject",
            "bioprojectAccession": "BioProject",
            "study_accession": "ENA Study",
            "studyAccession": "ENA Study",
            "sample_accession": "ENA Sample",
            "sampleAccession": "ENA Sample",
            "run_accession": "ENA Run",
            "runAccession": "ENA Run",
            "experiment_accession": "ENA Experiment",
            "experimentAccession": "ENA Experiment",
            "analysis_accession": "ENA Analysis",
            "analysisAccession": "ENA Analysis",
            "assembly_accession": "ENA Assembly",
            "assemblyAccession": "ENA Assembly",
            "submission_accession": "ENA Submission",
            "submissionAccession": "ENA Submission",
            "doi": "DOI",
        }

        seen = {
            (
                item["source"].casefold(),
                item["identifier"].casefold(),
            )
            for item in result
        }

        for field, source in known_fields.items():
            for identifier in cls._list_value(raw.get(field)):
                normalized = normalize_space(identifier)
                key = (
                    source.casefold(),
                    normalized.casefold(),
                )

                if not normalized or key in seen:
                    continue

                seen.add(key)
                result.append(
                    {
                        "identifier": normalized,
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
                        "doi": normalize_space(
                            cls._first_value(item, "doi")
                        ),
                        "pubmed_id": normalize_space(
                            cls._first_value(
                                item,
                                "pubmed_id",
                                "pubmedId",
                                "pmid",
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
                            "pubmed_id": "",
                            "url": "",
                            "raw": item,
                        }
                    )

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
            "super kingdom": "domain",
            "superkingdom": "domain",
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
        status = normalize_space(value).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "valid",
            "current": "accepted",
            "public": "reference",
            "released": "reference",
            "suppressed": "inactive",
            "withdrawn": "inactive",
            "replaced": "inactive",
            "synonym": "synonym",
            "unclassified": "unknown",
            "uncultured": "reference",
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
                f"Invalid ENA cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "ENA cursor must be non-negative."
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
