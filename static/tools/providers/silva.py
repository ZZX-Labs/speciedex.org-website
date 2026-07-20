#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/silva.py

SILVA ribosomal RNA taxonomy provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It does not assume access to an undocumented,
unlicensed, or unstable public API.

Each source record is normalized into the shared Taxon contract while the
complete SILVA object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "silva",
        "path": "static/data/providers/silva/taxa.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "SILVA Ribosomal RNA Database",
        "source_url": "https://www.arb-silva.de/"
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
    """File-backed SILVA provider."""

    PROVIDER_NAME = "silva"

    DEFAULT_SOURCE_NAME = "SILVA Ribosomal RNA Database"
    DEFAULT_SOURCE_URL = "https://www.arb-silva.de/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable SILVA JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"SILVA export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"SILVA path is not a file: {source_path}"
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
        """Resolve the configured SILVA JSONL source path."""

        configured = normalize_space(
            self.definition.get(
                "path"
            )
        )

        if not configured:
            raise ProviderError(
                "SILVA provider requires a path."
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
        """Normalize one SILVA sequence or taxonomy record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "silva_id",
                "silvaId",
                "sequence_id",
                "sequenceId",
                "accession",
                "primary_accession",
                "primaryAccession",
                "taxon_id",
                "taxonId",
                "id",
            )
        )

        lineage_string = normalize_space(
            self._first_value(
                raw,
                "lineage",
                "taxonomy",
                "taxonomic_path",
                "taxonomicPath",
                "classification",
            )
        )

        lineage = self._extract_lineage(
            raw,
            lineage_string=lineage_string,
        )

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "organism_name",
                "organismName",
                "taxon_name",
                "taxonName",
                "name",
            )
        )

        if not scientific_name:
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
                if lineage.get(
                    candidate
                ):
                    scientific_name = lineage[
                        candidate
                    ]
                    break

        if not provider_id or not scientific_name:
            return None

        canonical_name = normalize_space(
            self._first_value(
                raw,
                "canonical_name",
                "canonicalName",
                "organism_name",
                "organismName",
                "name",
            )
        ) or scientific_name

        rank = self._determine_rank(
            raw,
            lineage,
            scientific_name,
        )

        status = self._normalize_status(
            self._first_value(
                raw,
                "status",
                "taxonomic_status",
                "taxonomicStatus",
                "curation_status",
                "curationStatus",
            )
        )

        accepted_provider_id = normalize_space(
            self._first_value(
                raw,
                "accepted_taxon_id",
                "acceptedTaxonId",
                "accepted_id",
                "acceptedId",
                "reference_sequence_id",
                "referenceSequenceId",
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
                    "author",
                )
            ),
            kingdom=lineage.get(
                "kingdom",
                lineage.get(
                    "domain",
                    "",
                ),
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
                    "release",
                    "silva_release",
                    "silvaRelease",
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
                "programme": "silva",
                "reference_only": True,
                "sequence_id": provider_id,
                "accepted_taxon_id": accepted_provider_id,
                "lineage": lineage,
                "lineage_string": lineage_string,
                "domain": lineage.get(
                    "domain",
                    "",
                ),
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
                "sequence": {
                    "accession": normalize_space(
                        self._first_value(
                            raw,
                            "accession",
                            "primary_accession",
                            "primaryAccession",
                        )
                    ),
                    "secondary_accessions": self._normalize_identifier_list(
                        self._first_value(
                            raw,
                            "secondary_accessions",
                            "secondaryAccessions",
                            "accessions",
                        )
                    ),
                    "sequence": normalize_space(
                        self._first_value(
                            raw,
                            "sequence",
                            "nucleotides",
                            "rrna_sequence",
                            "rrnaSequence",
                        )
                    ),
                    "length": self._optional_int(
                        self._first_value(
                            raw,
                            "sequence_length",
                            "sequenceLength",
                            "length",
                        )
                    ),
                    "molecule_type": normalize_space(
                        self._first_value(
                            raw,
                            "molecule_type",
                            "moleculeType",
                            "marker",
                            "gene",
                        )
                    ),
                    "gene": normalize_space(
                        self._first_value(
                            raw,
                            "gene",
                            "gene_name",
                            "geneName",
                        )
                    ),
                    "region": normalize_space(
                        self._first_value(
                            raw,
                            "region",
                            "rrna_region",
                            "rrnaRegion",
                        )
                    ),
                },
                "organism": {
                    "name": scientific_name,
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
                    "culture_collection": normalize_space(
                        self._first_value(
                            raw,
                            "culture_collection",
                            "cultureCollection",
                            "collection",
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
                "environment": {
                    "environmental_sample": self._optional_bool(
                        self._first_value(
                            raw,
                            "environmental_sample",
                            "environmentalSample",
                            "is_environmental",
                            "isEnvironmental",
                        )
                    ),
                    "uncultured": self._optional_bool(
                        self._first_value(
                            raw,
                            "uncultured",
                            "is_uncultured",
                            "isUncultured",
                        )
                    ),
                    "metagenome": self._optional_bool(
                        self._first_value(
                            raw,
                            "metagenome",
                            "is_metagenome",
                            "isMetagenome",
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
                "alignment": {
                    "aligned_length": self._optional_int(
                        self._first_value(
                            raw,
                            "aligned_length",
                            "alignedLength",
                        )
                    ),
                    "alignment_start": self._optional_int(
                        self._first_value(
                            raw,
                            "alignment_start",
                            "alignmentStart",
                        )
                    ),
                    "alignment_end": self._optional_int(
                        self._first_value(
                            raw,
                            "alignment_end",
                            "alignmentEnd",
                        )
                    ),
                    "alignment_identity": self._optional_float(
                        self._first_value(
                            raw,
                            "alignment_identity",
                            "alignmentIdentity",
                            "identity",
                        )
                    ),
                    "alignment_score": self._optional_float(
                        self._first_value(
                            raw,
                            "alignment_score",
                            "alignmentScore",
                            "score",
                        )
                    ),
                },
                "quality": {
                    "quality_score": self._optional_float(
                        self._first_value(
                            raw,
                            "quality_score",
                            "qualityScore",
                        )
                    ),
                    "pintail": self._optional_float(
                        self._first_value(
                            raw,
                            "pintail",
                            "pintail_score",
                            "pintailScore",
                        )
                    ),
                    "ambiguities": self._optional_int(
                        self._first_value(
                            raw,
                            "ambiguities",
                            "ambiguous_bases",
                            "ambiguousBases",
                        )
                    ),
                    "homopolymers": self._optional_int(
                        self._first_value(
                            raw,
                            "homopolymers",
                            "homopolymer_count",
                            "homopolymerCount",
                        )
                    ),
                    "chimeric": self._optional_bool(
                        self._first_value(
                            raw,
                            "chimeric",
                            "is_chimeric",
                            "isChimeric",
                        )
                    ),
                    "trusted": self._optional_bool(
                        self._first_value(
                            raw,
                            "trusted",
                            "is_trusted",
                            "isTrusted",
                        )
                    ),
                },
                "curation": {
                    "dataset": normalize_space(
                        self._first_value(
                            raw,
                            "dataset",
                            "dataset_name",
                            "datasetName",
                        )
                    ),
                    "release": normalize_space(
                        self._first_value(
                            raw,
                            "release",
                            "silva_release",
                            "silvaRelease",
                        )
                    ),
                    "curated": self._optional_bool(
                        self._first_value(
                            raw,
                            "curated",
                            "is_curated",
                            "isCurated",
                        )
                    ),
                    "reference": self._optional_bool(
                        self._first_value(
                            raw,
                            "reference",
                            "is_reference",
                            "isReference",
                        )
                    ),
                    "seed": self._optional_bool(
                        self._first_value(
                            raw,
                            "seed",
                            "is_seed",
                            "isSeed",
                        )
                    ),
                },
                "identifiers": self._normalize_identifiers(
                    self._first_value(
                        raw,
                        "identifiers",
                        "external_identifiers",
                        "externalIdentifiers",
                    )
                ),
                "references": self._normalize_references(
                    self._first_value(
                        raw,
                        "references",
                        "reference_records",
                        "referenceRecords",
                        "publications",
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
        lineage_string: str,
    ) -> dict[str, str]:
        """Extract SILVA lineage from direct fields or a delimited path."""

        lineage = {
            "domain": normalize_space(
                cls._first_value(
                    raw,
                    "domain",
                    "superkingdom",
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

        ranked_lineage = cls._first_value(
            raw,
            "ranked_lineage",
            "rankedLineage",
            "lineage_records",
            "lineageRecords",
        )

        for item in cls._list_value(
            ranked_lineage
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

        if lineage_string:
            parts = [
                normalize_space(
                    item
                )
                for item in lineage_string.replace(
                    "|",
                    ";",
                ).split(
                    ";"
                )
                if normalize_space(
                    item
                )
            ]

            ordered_ranks = (
                "domain",
                "phylum",
                "class",
                "order",
                "family",
                "genus",
                "species",
            )

            for rank, name in zip(
                ordered_ranks,
                parts,
            ):
                if not lineage.get(
                    rank
                ):
                    lineage[
                        rank
                    ] = name

        if (
            not lineage.get(
                "kingdom"
            )
            and lineage.get(
                "domain"
            )
        ):
            lineage[
                "kingdom"
            ] = lineage[
                "domain"
            ]

        return lineage

    @classmethod
    def _extract_synonyms(
        cls,
        raw: Mapping[str, Any],
        *,
        scientific_name: str,
        canonical_name: str,
    ) -> list[str]:
        """Extract and deduplicate alternate organism names."""

        values = cls._list_value(
            cls._first_value(
                raw,
                "synonyms",
                "synonym",
                "alternative_names",
                "alternativeNames",
                "organism_synonyms",
                "organismSynonyms",
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

    @staticmethod
    def _determine_rank(
        raw: Mapping[str, Any],
        lineage: Mapping[str, str],
        scientific_name: str,
    ) -> str:
        """Determine the record rank from explicit or lineage data."""

        rank = Provider._normalize_rank(
            Provider._first_value(
                raw,
                "rank",
                "taxon_rank",
                "taxonRank",
            )
        )

        if rank != "unknown":
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
            value = normalize_space(
                lineage.get(
                    candidate
                )
            )

            if (
                value
                and value.casefold()
                == scientific_name.casefold()
            ):
                return candidate

        words = normalize_space(
            scientific_name
        ).split()

        if len(words) >= 2:
            return "species"

        return "unknown"

    @classmethod
    def _normalize_identifier_list(
        cls,
        value: Any,
    ) -> list[str]:
        """Normalize delimited or array-based accession identifiers."""

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
    def _normalize_identifiers(
        cls,
        value: Any,
    ) -> list[dict[str, str]]:
        """Normalize external sequence and taxonomy identifiers."""

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
                        "accession",
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
        """Normalize SILVA references and source publications."""

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
                            "pubmed_id": "",
                            "url": "",
                        }
                    )

        return result

    @staticmethod
    def _normalize_rank(
        value: Any,
    ) -> str:
        """Normalize microbial taxonomic rank labels."""

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
            rank.replace(
                " ",
                "_",
            ),
        )

    @staticmethod
    def _normalize_status(
        value: Any,
    ) -> str:
        """Normalize SILVA taxonomic and curation status labels."""

        status = normalize_space(
            value
        ).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "valid",
            "curated": "accepted",
            "reference": "reference",
            "seed": "reference",
            "uncultured": "reference",
            "environmental sample": "reference",
            "unclassified": "unknown",
            "unresolved": "unknown",
            "synonym": "synonym",
        }

        return aliases.get(
            status,
            status or "reference",
        )

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
                f"Invalid SILVA cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "SILVA cursor must be non-negative."
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
