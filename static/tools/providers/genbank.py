#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/genbank.py

GenBank provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It is intended for GenBank nucleotide-sequence,
taxonomy, source-organism, feature, gene, coding-sequence, protein, reference,
BioSample, BioProject, assembly, submitter, geographic, collection, and
provenance metadata.

Each source record is normalized into the shared Speciedex Taxon contract while
the complete GenBank source object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "genbank",
        "path": "static/data/providers/genbank/records.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "GenBank",
        "source_url": "https://www.ncbi.nlm.nih.gov/nuccore/"
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
    """File-backed GenBank provider."""

    PROVIDER_NAME = "genbank"

    DEFAULT_SOURCE_NAME = "GenBank"
    DEFAULT_SOURCE_URL = "https://www.ncbi.nlm.nih.gov/nuccore/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable GenBank JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"GenBank export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"GenBank path is not a file: {source_path}"
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
                            f"Invalid GenBank JSON at "
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
        """Resolve the configured GenBank JSONL source path."""

        configured = normalize_space(
            self.definition.get("path")
            or self.definition.get("file")
            or self.definition.get("source_path")
        )

        if not configured:
            raise ProviderError(
                "GenBank provider requires a path."
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
        """Normalize one GenBank sequence record."""

        accession = normalize_space(
            self._first_value(
                raw,
                "accession",
                "primary_accession",
                "primaryAccession",
                "accession_version",
                "accessionVersion",
                "locus",
                "id",
            )
        )

        version = normalize_space(
            self._first_value(
                raw,
                "version",
                "accession_version",
                "accessionVersion",
            )
        )

        provider_id = version or accession

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "organism",
                "organism_name",
                "organismName",
                "source_organism",
                "sourceOrganism",
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
                "record_status",
                "recordStatus",
                "taxonomic_status",
                "taxonomicStatus",
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
                + "/"
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
                    "update_date",
                    "updateDate",
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
                "programme": "genbank",
                "reference_only": True,
                "accession": accession,
                "version": version,
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
                    "isolate": normalize_space(
                        self._first_value(
                            raw,
                            "isolate",
                            "isolate_name",
                            "isolateName",
                        )
                    ),
                    "subspecies": normalize_space(
                        self._first_value(
                            raw,
                            "subspecies",
                        )
                    ),
                    "cultivar": normalize_space(
                        self._first_value(
                            raw,
                            "cultivar",
                        )
                    ),
                    "breed": normalize_space(
                        self._first_value(
                            raw,
                            "breed",
                        )
                    ),
                    "serovar": normalize_space(
                        self._first_value(
                            raw,
                            "serovar",
                        )
                    ),
                    "serotype": normalize_space(
                        self._first_value(
                            raw,
                            "serotype",
                        )
                    ),
                    "ecotype": normalize_space(
                        self._first_value(
                            raw,
                            "ecotype",
                        )
                    ),
                    "forma_specialis": normalize_space(
                        self._first_value(
                            raw,
                            "forma_specialis",
                            "formaSpecialis",
                        )
                    ),
                },
                "sequence_record": {
                    "locus": normalize_space(
                        self._first_value(
                            raw,
                            "locus",
                            "locus_name",
                            "locusName",
                        )
                    ),
                    "definition": normalize_space(
                        self._first_value(
                            raw,
                            "definition",
                            "description",
                            "title",
                        )
                    ),
                    "molecule_type": normalize_space(
                        self._first_value(
                            raw,
                            "molecule_type",
                            "moleculeType",
                        )
                    ),
                    "topology": normalize_space(
                        self._first_value(
                            raw,
                            "topology",
                        )
                    ),
                    "division": normalize_space(
                        self._first_value(
                            raw,
                            "division",
                            "genbank_division",
                            "genbankDivision",
                        )
                    ),
                    "sequence_length": self._optional_int(
                        self._first_value(
                            raw,
                            "sequence_length",
                            "sequenceLength",
                            "length",
                        )
                    ),
                    "base_count": self._optional_int(
                        self._first_value(
                            raw,
                            "base_count",
                            "baseCount",
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
                    "completeness": normalize_space(
                        self._first_value(
                            raw,
                            "completeness",
                            "sequence_completeness",
                            "sequenceCompleteness",
                        )
                    ),
                    "keywords": self._list_value(
                        self._first_value(
                            raw,
                            "keywords",
                            "keyword",
                        )
                    ),
                    "create_date": normalize_space(
                        self._first_value(
                            raw,
                            "create_date",
                            "createDate",
                        )
                    ),
                    "update_date": normalize_space(
                        self._first_value(
                            raw,
                            "update_date",
                            "updateDate",
                        )
                    ),
                },
                "source_feature": {
                    "country": normalize_space(
                        self._first_value(
                            raw,
                            "country",
                            "geo_loc_name",
                            "geoLocName",
                        )
                    ),
                    "collection_date": normalize_space(
                        self._first_value(
                            raw,
                            "collection_date",
                            "collectionDate",
                        )
                    ),
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
                    "altitude_m": self._optional_float(
                        self._first_value(
                            raw,
                            "altitude",
                            "altitude_m",
                            "altitudeM",
                            "elevation",
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
                    "environmental_sample": self._optional_bool(
                        self._first_value(
                            raw,
                            "environmental_sample",
                            "environmentalSample",
                        )
                    ),
                    "metagenome_source": normalize_space(
                        self._first_value(
                            raw,
                            "metagenome_source",
                            "metagenomeSource",
                        )
                    ),
                    "cell_line": normalize_space(
                        self._first_value(
                            raw,
                            "cell_line",
                            "cellLine",
                        )
                    ),
                    "cell_type": normalize_space(
                        self._first_value(
                            raw,
                            "cell_type",
                            "cellType",
                        )
                    ),
                    "tissue_type": normalize_space(
                        self._first_value(
                            raw,
                            "tissue_type",
                            "tissueType",
                        )
                    ),
                    "dev_stage": normalize_space(
                        self._first_value(
                            raw,
                            "dev_stage",
                            "devStage",
                        )
                    ),
                    "sex": normalize_space(
                        self._first_value(
                            raw,
                            "sex",
                        )
                    ),
                    "specimen_voucher": normalize_space(
                        self._first_value(
                            raw,
                            "specimen_voucher",
                            "specimenVoucher",
                        )
                    ),
                    "culture_collection": normalize_space(
                        self._first_value(
                            raw,
                            "culture_collection",
                            "cultureCollection",
                        )
                    ),
                    "bio_material": normalize_space(
                        self._first_value(
                            raw,
                            "bio_material",
                            "bioMaterial",
                        )
                    ),
                },
                "features": self._normalize_features(
                    self._first_value(
                        raw,
                        "features",
                        "feature_table",
                        "featureTable",
                    )
                ),
                "genes": self._normalize_gene_records(
                    self._first_value(
                        raw,
                        "genes",
                        "gene_records",
                        "geneRecords",
                    )
                ),
                "coding_sequences": self._normalize_cds_records(
                    self._first_value(
                        raw,
                        "coding_sequences",
                        "codingSequences",
                        "cds",
                        "cds_features",
                        "cdsFeatures",
                    )
                ),
                "proteins": self._normalize_protein_records(
                    self._first_value(
                        raw,
                        "proteins",
                        "protein_records",
                        "proteinRecords",
                    )
                ),
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
                    "genome_representation": normalize_space(
                        self._first_value(
                            raw,
                            "genome_representation",
                            "genomeRepresentation",
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
                },
                "project": {
                    "bioproject_accession": normalize_space(
                        self._first_value(
                            raw,
                            "bioproject_accession",
                            "bioprojectAccession",
                            "project_accession",
                            "projectAccession",
                        )
                    ),
                    "biosample_accession": normalize_space(
                        self._first_value(
                            raw,
                            "biosample_accession",
                            "biosampleAccession",
                            "sample_accession",
                            "sampleAccession",
                        )
                    ),
                    "sra_accessions": self._normalize_accessions(
                        self._first_value(
                            raw,
                            "sra_accessions",
                            "sraAccessions",
                            "sra_accession",
                            "sraAccession",
                        )
                    ),
                    "trace_accessions": self._normalize_accessions(
                        self._first_value(
                            raw,
                            "trace_accessions",
                            "traceAccessions",
                        )
                    ),
                },
                "submitter": {
                    "submitter_name": normalize_space(
                        self._first_value(
                            raw,
                            "submitter_name",
                            "submitterName",
                            "submitter",
                        )
                    ),
                    "institution": normalize_space(
                        self._first_value(
                            raw,
                            "institution",
                            "organization",
                        )
                    ),
                    "department": normalize_space(
                        self._first_value(
                            raw,
                            "department",
                        )
                    ),
                    "address": normalize_space(
                        self._first_value(
                            raw,
                            "address",
                        )
                    ),
                    "email": normalize_space(
                        self._first_value(
                            raw,
                            "email",
                            "submitter_email",
                            "submitterEmail",
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
                "db_xrefs": self._normalize_db_xrefs(
                    self._first_value(
                        raw,
                        "db_xrefs",
                        "dbXrefs",
                        "database_cross_references",
                        "databaseCrossReferences",
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
                        "publications",
                    )
                ),
                "comments": self._list_value(
                    self._first_value(
                        raw,
                        "comments",
                        "comment",
                        "notes",
                        "remarks",
                    )
                ),
                "sequence": self._first_value(
                    raw,
                    "sequence",
                    "residues",
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
        """Extract NCBI-style taxonomic lineage."""

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

        if isinstance(lineage_value, str):
            lineage_value = [
                part.strip()
                for part in lineage_value.split(";")
                if part.strip()
            ]

        for item in cls._list_value(lineage_value):
            if isinstance(item, Mapping):
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
    def _normalize_features(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize GenBank feature-table entries."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if not isinstance(item, Mapping):
                continue

            qualifiers = cls._first_value(
                item,
                "qualifiers",
                "attributes",
            )

            result.append(
                {
                    "type": normalize_space(
                        cls._first_value(
                            item,
                            "type",
                            "feature_type",
                            "featureType",
                            "key",
                        )
                    ),
                    "location": normalize_space(
                        cls._first_value(
                            item,
                            "location",
                            "range",
                        )
                    ),
                    "strand": normalize_space(
                        cls._first_value(
                            item,
                            "strand",
                        )
                    ),
                    "start": cls._optional_int(
                        cls._first_value(
                            item,
                            "start",
                            "from",
                        )
                    ),
                    "end": cls._optional_int(
                        cls._first_value(
                            item,
                            "end",
                            "to",
                        )
                    ),
                    "partial": cls._optional_bool(
                        cls._first_value(
                            item,
                            "partial",
                            "is_partial",
                            "isPartial",
                        )
                    ),
                    "qualifiers": cls._normalize_qualifiers(
                        qualifiers
                    ),
                    "raw": dict(item),
                }
            )

        return result

    @classmethod
    def _normalize_gene_records(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize gene features."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                result.append(
                    {
                        "gene": normalize_space(
                            cls._first_value(
                                item,
                                "gene",
                                "name",
                                "symbol",
                            )
                        ),
                        "locus_tag": normalize_space(
                            cls._first_value(
                                item,
                                "locus_tag",
                                "locusTag",
                            )
                        ),
                        "gene_id": normalize_space(
                            cls._first_value(
                                item,
                                "gene_id",
                                "geneId",
                                "id",
                            )
                        ),
                        "location": normalize_space(
                            cls._first_value(
                                item,
                                "location",
                            )
                        ),
                        "synonyms": cls._list_value(
                            cls._first_value(
                                item,
                                "synonyms",
                                "gene_synonyms",
                                "geneSynonyms",
                            )
                        ),
                        "note": normalize_space(
                            cls._first_value(
                                item,
                                "note",
                                "description",
                            )
                        ),
                        "raw": dict(item),
                    }
                )

        return result

    @classmethod
    def _normalize_cds_records(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize coding-sequence features."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                result.append(
                    {
                        "gene": normalize_space(
                            cls._first_value(
                                item,
                                "gene",
                            )
                        ),
                        "locus_tag": normalize_space(
                            cls._first_value(
                                item,
                                "locus_tag",
                                "locusTag",
                            )
                        ),
                        "product": normalize_space(
                            cls._first_value(
                                item,
                                "product",
                                "protein_name",
                                "proteinName",
                            )
                        ),
                        "protein_id": normalize_space(
                            cls._first_value(
                                item,
                                "protein_id",
                                "proteinId",
                            )
                        ),
                        "translation": cls._first_value(
                            item,
                            "translation",
                            "protein_sequence",
                            "proteinSequence",
                        ),
                        "codon_start": cls._optional_int(
                            cls._first_value(
                                item,
                                "codon_start",
                                "codonStart",
                            )
                        ),
                        "translation_table": cls._optional_int(
                            cls._first_value(
                                item,
                                "translation_table",
                                "translationTable",
                                "transl_table",
                                "translTable",
                            )
                        ),
                        "location": normalize_space(
                            cls._first_value(
                                item,
                                "location",
                            )
                        ),
                        "partial": cls._optional_bool(
                            cls._first_value(
                                item,
                                "partial",
                                "is_partial",
                                "isPartial",
                            )
                        ),
                        "pseudo": cls._optional_bool(
                            cls._first_value(
                                item,
                                "pseudo",
                                "is_pseudo",
                                "isPseudo",
                            )
                        ),
                        "note": normalize_space(
                            cls._first_value(
                                item,
                                "note",
                                "description",
                            )
                        ),
                        "db_xrefs": cls._normalize_db_xrefs(
                            cls._first_value(
                                item,
                                "db_xrefs",
                                "dbXrefs",
                            )
                        ),
                        "raw": dict(item),
                    }
                )

        return result

    @classmethod
    def _normalize_protein_records(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize linked protein records."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                result.append(
                    {
                        "protein_id": normalize_space(
                            cls._first_value(
                                item,
                                "protein_id",
                                "proteinId",
                                "accession",
                                "id",
                            )
                        ),
                        "name": normalize_space(
                            cls._first_value(
                                item,
                                "name",
                                "product",
                                "protein_name",
                                "proteinName",
                            )
                        ),
                        "sequence": cls._first_value(
                            item,
                            "sequence",
                            "translation",
                        ),
                        "length": cls._optional_int(
                            cls._first_value(
                                item,
                                "length",
                                "sequence_length",
                                "sequenceLength",
                            )
                        ),
                        "gene": normalize_space(
                            cls._first_value(
                                item,
                                "gene",
                            )
                        ),
                        "locus_tag": normalize_space(
                            cls._first_value(
                                item,
                                "locus_tag",
                                "locusTag",
                            )
                        ),
                        "db_xrefs": cls._normalize_db_xrefs(
                            cls._first_value(
                                item,
                                "db_xrefs",
                                "dbXrefs",
                            )
                        ),
                        "raw": dict(item),
                    }
                )

        return result

    @classmethod
    def _normalize_qualifiers(
        cls,
        value: Any,
    ) -> dict[str, Any]:
        """Normalize GenBank feature qualifiers."""

        if isinstance(value, Mapping):
            return {
                normalize_space(key): item
                for key, item in value.items()
                if normalize_space(key)
            }

        result: dict[str, Any] = {}

        for item in cls._list_value(value):
            if not isinstance(item, Mapping):
                continue

            key = normalize_space(
                cls._first_value(
                    item,
                    "name",
                    "key",
                    "qualifier",
                )
            )
            qualifier_value = cls._first_value(
                item,
                "value",
                "content",
            )

            if key:
                result[key] = qualifier_value

        return result

    @classmethod
    def _normalize_db_xrefs(
        cls,
        value: Any,
    ) -> list[dict[str, str]]:
        """Normalize database cross-references."""

        result: list[dict[str, str]] = []
        seen: set[tuple[str, str]] = set()

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                database = normalize_space(
                    cls._first_value(
                        item,
                        "database",
                        "db",
                        "source",
                    )
                )
                identifier = normalize_space(
                    cls._first_value(
                        item,
                        "identifier",
                        "id",
                        "value",
                    )
                )
            else:
                text = normalize_space(item)
                database, separator, identifier = text.partition(":")

                if not separator:
                    database = ""
                    identifier = text

            key = (
                database.casefold(),
                identifier.casefold(),
            )

            if not identifier or key in seen:
                continue

            seen.add(key)
            result.append(
                {
                    "database": database,
                    "identifier": identifier,
                }
            )

        return result

    @classmethod
    def _normalize_accessions(
        cls,
        value: Any,
    ) -> list[str]:
        """Normalize accession lists."""

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
    def _normalize_identifiers(
        cls,
        value: Any,
        *,
        raw: Mapping[str, Any],
    ) -> list[dict[str, str]]:
        """Normalize GenBank and external identifiers."""

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
            "accession": "GenBank",
            "primary_accession": "GenBank",
            "primaryAccession": "GenBank",
            "accession_version": "GenBank",
            "accessionVersion": "GenBank",
            "gi": "NCBI GI",
            "tax_id": "NCBI Taxonomy",
            "taxId": "NCBI Taxonomy",
            "ncbi_taxid": "NCBI Taxonomy",
            "ncbiTaxid": "NCBI Taxonomy",
            "biosample_accession": "BioSample",
            "biosampleAccession": "BioSample",
            "bioproject_accession": "BioProject",
            "bioprojectAccession": "BioProject",
            "assembly_accession": "NCBI Assembly",
            "assemblyAccession": "NCBI Assembly",
            "sra_accession": "SRA",
            "sraAccession": "SRA",
            "ena_accession": "ENA",
            "enaAccession": "ENA",
            "doi": "DOI",
        }

        seen = {
            (
                entry["source"].casefold(),
                entry["identifier"].casefold(),
            )
            for entry in result
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
        """Normalize GenBank references."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                result.append(
                    {
                        "title": normalize_space(
                            cls._first_value(
                                item,
                                "title",
                                "citation",
                            )
                        ),
                        "authors": normalize_space(
                            cls._first_value(
                                item,
                                "authors",
                                "author",
                            )
                        ),
                        "journal": normalize_space(
                            cls._first_value(
                                item,
                                "journal",
                                "publication",
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
                        "pubmed_id": normalize_space(
                            cls._first_value(
                                item,
                                "pubmed_id",
                                "pubmedId",
                                "pmid",
                            )
                        ),
                        "medline_id": normalize_space(
                            cls._first_value(
                                item,
                                "medline_id",
                                "medlineId",
                            )
                        ),
                        "doi": normalize_space(
                            cls._first_value(
                                item,
                                "doi",
                            )
                        ),
                        "remark": normalize_space(
                            cls._first_value(
                                item,
                                "remark",
                                "remarks",
                                "note",
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
                            "title": citation,
                            "authors": "",
                            "journal": "",
                            "year": "",
                            "pubmed_id": "",
                            "medline_id": "",
                            "doi": "",
                            "remark": "",
                            "raw": item,
                        }
                    )

        return result

    @staticmethod
    def _normalize_rank(value: Any) -> str:
        """Normalize NCBI-style taxonomic ranks."""

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
            "clade": "clade",
            "strain": "strain",
            "isolate": "isolate",
        }

        if not rank:
            return "unknown"

        return aliases.get(
            rank,
            rank.replace(" ", "_"),
        )

    @staticmethod
    def _normalize_status(value: Any) -> str:
        """Normalize GenBank record and taxonomic statuses."""

        status = normalize_space(value).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "valid",
            "current": "accepted",
            "public": "reference",
            "released": "reference",
            "live": "reference",
            "suppressed": "inactive",
            "withdrawn": "inactive",
            "replaced": "inactive",
            "dead": "inactive",
            "synonym": "synonym",
            "unclassified": "unknown",
            "uncultured": "reference",
            "environmental sample": "reference",
            "reference": "reference",
        }

        return aliases.get(
            status,
            status or "reference",
        )

    @staticmethod
    def _infer_rank(scientific_name: str) -> str:
        """Infer taxonomic rank from a scientific-name string."""

        words = normalize_space(scientific_name).split()
        lowered = {word.casefold() for word in words}

        if "subsp." in lowered or "subspecies" in lowered:
            return "subspecies"

        if "strain" in lowered:
            return "strain"

        if "isolate" in lowered:
            return "isolate"

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
                f"Invalid GenBank cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "GenBank cursor must be non-negative."
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
            "present",
            "partial",
        }:
            return True

        if normalized in {
            "0",
            "false",
            "no",
            "n",
            "absent",
            "complete",
        }:
            return False

        return None
