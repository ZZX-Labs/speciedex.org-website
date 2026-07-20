#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/gtdb.py

Genome Taxonomy Database (GTDB) provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It does not assume access to an undocumented,
unlicensed, or unstable public API.

Each source record is normalized into the shared Taxon contract while the
complete GTDB object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "gtdb",
        "path": "static/data/providers/gtdb/taxa.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "Genome Taxonomy Database",
        "source_url": "https://gtdb.ecogenomic.org/"
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
    """File-backed Genome Taxonomy Database provider."""

    PROVIDER_NAME = "gtdb"

    DEFAULT_SOURCE_NAME = "Genome Taxonomy Database"
    DEFAULT_SOURCE_URL = "https://gtdb.ecogenomic.org/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable GTDB JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"GTDB export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"GTDB path is not a file: {source_path}"
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

    def _source_path(
        self,
    ) -> Path:
        """Resolve the configured GTDB JSONL source path."""

        configured = normalize_space(
            self.definition.get(
                "path"
            )
        )

        if not configured:
            raise ProviderError(
                "GTDB provider requires a path."
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
        """Normalize one GTDB genome or taxon record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "gtdb_taxon_id",
                "gtdbTaxonId",
                "accession",
                "genome_id",
                "genomeId",
                "assembly_accession",
                "assemblyAccession",
                "id",
            )
        )

        taxonomy_string = normalize_space(
            self._first_value(
                raw,
                "gtdb_taxonomy",
                "gtdbTaxonomy",
                "taxonomy",
                "classification",
            )
        )

        parsed_taxonomy = self._parse_taxonomy(
            taxonomy_string,
            raw,
        )

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "species",
                "species_name",
                "speciesName",
                "name",
            )
        )

        if not scientific_name:
            scientific_name = (
                parsed_taxonomy.get(
                    "species",
                    "",
                )
                or parsed_taxonomy.get(
                    "genus",
                    "",
                )
                or parsed_taxonomy.get(
                    "family",
                    "",
                )
                or parsed_taxonomy.get(
                    "order",
                    "",
                )
                or parsed_taxonomy.get(
                    "class",
                    "",
                )
                or parsed_taxonomy.get(
                    "phylum",
                    "",
                )
                or parsed_taxonomy.get(
                    "domain",
                    "",
                )
            )

        scientific_name = self._strip_rank_prefix(
            scientific_name
        )

        if not provider_id or not scientific_name:
            return None

        canonical_name = normalize_space(
            self._first_value(
                raw,
                "canonical_name",
                "canonicalName",
                "species_name",
                "speciesName",
                "name",
            )
        ) or scientific_name

        canonical_name = self._strip_rank_prefix(
            canonical_name
        )

        rank = self._determine_rank(
            raw,
            parsed_taxonomy,
            scientific_name,
        )

        status = self._normalize_status(
            raw
        )

        representative_id = normalize_space(
            self._first_value(
                raw,
                "representative_genome",
                "representativeGenome",
                "species_representative",
                "speciesRepresentative",
                "gtdb_genome_representative",
                "gtdbGenomeRepresentative",
            )
        )

        accepted_provider_id = normalize_space(
            self._first_value(
                raw,
                "accepted_taxon_id",
                "acceptedTaxonId",
                "accepted_id",
                "acceptedId",
            )
        )

        if not accepted_provider_id:
            accepted_provider_id = representative_id

        if accepted_provider_id == provider_id:
            accepted_provider_id = ""

        source_url = normalize_space(
            self._first_value(
                raw,
                "url",
                "source_url",
                "sourceUrl",
                "genome_url",
                "genomeUrl",
            )
        ) or normalize_space(
            self.definition.get(
                "source_url",
                self.DEFAULT_SOURCE_URL,
            )
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
                    "authority",
                    "scientific_name_authorship",
                    "scientificNameAuthorship",
                )
            ),
            kingdom=parsed_taxonomy.get(
                "kingdom",
                "",
            ),
            phylum=parsed_taxonomy.get(
                "phylum",
                "",
            ),
            class_name=parsed_taxonomy.get(
                "class",
                "",
            ),
            order=parsed_taxonomy.get(
                "order",
                "",
            ),
            family=parsed_taxonomy.get(
                "family",
                "",
            ),
            genus=parsed_taxonomy.get(
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
                    "release",
                    "gtdb_release",
                    "gtdbRelease",
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
                "programme": "gtdb",
                "reference_only": True,
                "gtdb_taxon_id": provider_id,
                "gtdb_taxonomy": taxonomy_string,
                "lineage": parsed_taxonomy,
                "domain": parsed_taxonomy.get(
                    "domain",
                    "",
                ),
                "representative": {
                    "genome_id": representative_id,
                    "is_representative": self._optional_bool(
                        self._first_value(
                            raw,
                            "is_representative",
                            "isRepresentative",
                            "gtdb_representative",
                            "gtdbRepresentative",
                        )
                    ),
                    "cluster_size": self._optional_int(
                        self._first_value(
                            raw,
                            "cluster_size",
                            "clusterSize",
                            "species_cluster_size",
                            "speciesClusterSize",
                        )
                    ),
                },
                "assembly": {
                    "accession": normalize_space(
                        self._first_value(
                            raw,
                            "assembly_accession",
                            "assemblyAccession",
                            "accession",
                        )
                    ),
                    "ncbi_assembly_accession": normalize_space(
                        self._first_value(
                            raw,
                            "ncbi_assembly_accession",
                            "ncbiAssemblyAccession",
                        )
                    ),
                    "genbank_accession": normalize_space(
                        self._first_value(
                            raw,
                            "genbank_accession",
                            "genbankAccession",
                        )
                    ),
                    "refseq_accession": normalize_space(
                        self._first_value(
                            raw,
                            "refseq_accession",
                            "refseqAccession",
                        )
                    ),
                    "assembly_level": normalize_space(
                        self._first_value(
                            raw,
                            "assembly_level",
                            "assemblyLevel",
                        )
                    ),
                    "genome_size_bp": self._optional_int(
                        self._first_value(
                            raw,
                            "genome_size",
                            "genomeSize",
                            "genome_size_bp",
                            "genomeSizeBp",
                        )
                    ),
                    "contig_count": self._optional_int(
                        self._first_value(
                            raw,
                            "contig_count",
                            "contigCount",
                        )
                    ),
                    "n50": self._optional_int(
                        self._first_value(
                            raw,
                            "n50",
                            "contig_n50",
                            "contigN50",
                        )
                    ),
                    "gc_percentage": self._optional_float(
                        self._first_value(
                            raw,
                            "gc_percentage",
                            "gcPercentage",
                            "gc_percent",
                            "gcPercent",
                        )
                    ),
                },
                "quality": {
                    "completeness": self._optional_float(
                        self._first_value(
                            raw,
                            "completeness",
                            "checkm_completeness",
                            "checkmCompleteness",
                        )
                    ),
                    "contamination": self._optional_float(
                        self._first_value(
                            raw,
                            "contamination",
                            "checkm_contamination",
                            "checkmContamination",
                        )
                    ),
                    "quality_score": self._optional_float(
                        self._first_value(
                            raw,
                            "quality_score",
                            "qualityScore",
                        )
                    ),
                    "quality_category": normalize_space(
                        self._first_value(
                            raw,
                            "quality_category",
                            "qualityCategory",
                        )
                    ),
                    "type_material": self._optional_bool(
                        self._first_value(
                            raw,
                            "type_material",
                            "typeMaterial",
                            "is_type_material",
                            "isTypeMaterial",
                        )
                    ),
                },
                "placement": {
                    "ani": self._optional_float(
                        self._first_value(
                            raw,
                            "ani",
                            "fastani_reference_radius",
                            "fastaniReferenceRadius",
                        )
                    ),
                    "af": self._optional_float(
                        self._first_value(
                            raw,
                            "af",
                            "alignment_fraction",
                            "alignmentFraction",
                        )
                    ),
                    "closest_representative": normalize_space(
                        self._first_value(
                            raw,
                            "closest_representative",
                            "closestRepresentative",
                            "fastani_reference",
                            "fastaniReference",
                        )
                    ),
                    "placement_method": normalize_space(
                        self._first_value(
                            raw,
                            "placement_method",
                            "placementMethod",
                            "classification_method",
                            "classificationMethod",
                        )
                    ),
                    "red_value": self._optional_float(
                        self._first_value(
                            raw,
                            "red_value",
                            "redValue",
                            "relative_evolutionary_divergence",
                            "relativeEvolutionaryDivergence",
                        )
                    ),
                },
                "nomenclature": {
                    "ncbi_taxonomy": normalize_space(
                        self._first_value(
                            raw,
                            "ncbi_taxonomy",
                            "ncbiTaxonomy",
                        )
                    ),
                    "ncbi_taxid": normalize_space(
                        self._first_value(
                            raw,
                            "ncbi_taxid",
                            "ncbiTaxid",
                            "ncbi_tax_id",
                            "ncbiTaxId",
                        )
                    ),
                    "type_species": self._optional_bool(
                        self._first_value(
                            raw,
                            "type_species",
                            "typeSpecies",
                        )
                    ),
                    "type_genus": self._optional_bool(
                        self._first_value(
                            raw,
                            "type_genus",
                            "typeGenus",
                        )
                    ),
                    "proposed_name": normalize_space(
                        self._first_value(
                            raw,
                            "proposed_name",
                            "proposedName",
                        )
                    ),
                    "nomenclatural_status": normalize_space(
                        self._first_value(
                            raw,
                            "nomenclatural_status",
                            "nomenclaturalStatus",
                        )
                    ),
                },
                "isolation": {
                    "source": normalize_space(
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
                    "country": normalize_space(
                        self._first_value(
                            raw,
                            "country",
                            "geographic_location",
                            "geographicLocation",
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
                },
                "release": {
                    "gtdb_release": normalize_space(
                        self._first_value(
                            raw,
                            "gtdb_release",
                            "gtdbRelease",
                            "release",
                        )
                    ),
                    "release_date": normalize_space(
                        self._first_value(
                            raw,
                            "release_date",
                            "releaseDate",
                        )
                    ),
                },
                "references": self._normalize_references(
                    self._first_value(
                        raw,
                        "references",
                        "reference",
                        "publications",
                    )
                ),
                "identifiers": self._normalize_identifiers(
                    self._first_value(
                        raw,
                        "identifiers",
                        "external_identifiers",
                        "externalIdentifiers",
                    )
                ),
                "bulk_source": source_path.as_posix(),
                "raw": raw,
            },
        )

    @classmethod
    def _parse_taxonomy(
        cls,
        taxonomy: str,
        raw: Mapping[str, Any],
    ) -> dict[str, str]:
        """Parse GTDB rank-prefixed taxonomy strings."""

        result = {
            "domain": normalize_space(
                raw.get(
                    "domain"
                )
            ),
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

        prefix_map = {
            "d__": "domain",
            "k__": "kingdom",
            "p__": "phylum",
            "c__": "class",
            "o__": "order",
            "f__": "family",
            "g__": "genus",
            "s__": "species",
        }

        for part in taxonomy.split(
            ";"
        ):
            normalized = normalize_space(
                part
            )

            for prefix, rank in prefix_map.items():
                if normalized.startswith(
                    prefix
                ):
                    name = normalize_space(
                        normalized[
                            len(prefix):
                        ]
                    )

                    if name:
                        result[
                            rank
                        ] = name

                    break

        if (
            not result.get(
                "kingdom"
            )
            and result.get(
                "domain"
            )
        ):
            result[
                "kingdom"
            ] = result[
                "domain"
            ]

        return result

    @classmethod
    def _extract_synonyms(
        cls,
        raw: Mapping[str, Any],
        *,
        scientific_name: str,
        canonical_name: str,
    ) -> list[str]:
        """Extract and deduplicate alternative GTDB or NCBI names."""

        values = cls._list_value(
            cls._first_value(
                raw,
                "synonyms",
                "synonym",
                "alternative_names",
                "alternativeNames",
                "ncbi_synonyms",
                "ncbiSynonyms",
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
                        "name",
                        "scientific_name",
                        "scientificName",
                    )
                )
            else:
                normalized = normalize_space(
                    item
                )

            normalized = cls._strip_rank_prefix(
                normalized
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

    @staticmethod
    def _determine_rank(
        raw: Mapping[str, Any],
        taxonomy: Mapping[str, str],
        scientific_name: str,
    ) -> str:
        rank = normalize_space(
            Provider._first_value(
                raw,
                "rank",
                "taxon_rank",
                "taxonRank",
            )
        ).casefold()

        if rank:
            return rank

        for candidate in (
            "species",
            "genus",
            "family",
            "order",
            "class",
            "phylum",
            "kingdom",
            "domain",
        ):
            if (
                taxonomy.get(
                    candidate
                )
                and taxonomy[
                    candidate
                ].casefold()
                == scientific_name.casefold()
            ):
                return candidate

        words = scientific_name.split()

        if len(words) >= 2:
            return "species"

        return "unknown"

    @staticmethod
    def _normalize_status(
        raw: Mapping[str, Any],
    ) -> str:
        """Normalize GTDB record status."""

        if Provider._optional_bool(
            Provider._first_value(
                raw,
                "is_representative",
                "isRepresentative",
                "gtdb_representative",
                "gtdbRepresentative",
            )
        ):
            return "accepted"

        status = normalize_space(
            Provider._first_value(
                raw,
                "status",
                "taxonomic_status",
                "taxonomicStatus",
            )
        ).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "valid",
            "representative": "accepted",
            "non-representative": "reference",
            "non representative": "reference",
            "provisional": "provisionally accepted",
            "synonym": "synonym",
            "reference": "reference",
        }

        return aliases.get(
            status,
            status or "reference",
        )

    @classmethod
    def _normalize_references(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize GTDB references and publication metadata."""

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

    @classmethod
    def _normalize_identifiers(
        cls,
        value: Any,
    ) -> list[dict[str, str]]:
        """Normalize external assembly and taxonomy identifiers."""

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

    @staticmethod
    def _strip_rank_prefix(
        value: str,
    ) -> str:
        normalized = normalize_space(
            value
        )

        prefixes = (
            "d__",
            "k__",
            "p__",
            "c__",
            "o__",
            "f__",
            "g__",
            "s__",
        )

        for prefix in prefixes:
            if normalized.startswith(
                prefix
            ):
                return normalize_space(
                    normalized[
                        len(prefix):
                    ]
                )

        return normalized

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
                f"Invalid GTDB cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "GTDB cursor must be non-negative."
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
