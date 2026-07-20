#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/uniprot_taxonomy.py

UniProt Taxonomy provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It is intended for UniProt taxonomy records, NCBI
Taxonomy identifiers, scientific names, common names, synonyms, lineage,
taxonomic ranks, merged and deleted taxon nodes, proteome relationships,
host associations, references, external identifiers, and provenance metadata.

Each source record is normalized into the shared Speciedex Taxon contract while
the complete UniProt source object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "uniprot_taxonomy",
        "path": "static/data/providers/uniprot-taxonomy/taxa.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "UniProt Taxonomy",
        "source_url": "https://www.uniprot.org/taxonomy/"
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
    """File-backed UniProt Taxonomy provider."""

    PROVIDER_NAME = "uniprot_taxonomy"

    DEFAULT_SOURCE_NAME = "UniProt Taxonomy"
    DEFAULT_SOURCE_URL = "https://www.uniprot.org/taxonomy/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable UniProt Taxonomy JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"UniProt Taxonomy export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"UniProt Taxonomy path is not a file: {source_path}"
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
                            f"Invalid UniProt Taxonomy JSON at "
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
                "UniProt Taxonomy provider requires a path."
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
        """Normalize one UniProt taxonomy record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "taxon_id",
                "taxonId",
                "taxonID",
                "ncbi_taxon_id",
                "ncbiTaxonId",
                "taxonomy_id",
                "taxonomyId",
                "id",
            )
        )

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "organism_name",
                "organismName",
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

        status = self._normalize_status(
            self._first_value(
                raw,
                "status",
                "taxonomic_status",
                "taxonomicStatus",
                "node_status",
                "nodeStatus",
            ),
            raw=raw,
        )

        accepted_provider_id = normalize_space(
            self._first_value(
                raw,
                "merged_into",
                "mergedInto",
                "accepted_taxon_id",
                "acceptedTaxonId",
                "current_taxon_id",
                "currentTaxonId",
            )
        )

        if accepted_provider_id == provider_id:
            accepted_provider_id = ""

        parent_provider_id = normalize_space(
            self._first_value(
                raw,
                "parent_taxon_id",
                "parentTaxonId",
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
            source_url = f"{base}/{provider_id}"

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
            kingdom=lineage.get("kingdom", ""),
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
                "programme": "uniprot_taxonomy",
                "reference_only": True,
                "taxon_id": provider_id,
                "ncbi_taxon_id": provider_id,
                "accepted_taxon_id": accepted_provider_id,
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
                "names": {
                    "scientific_name": scientific_name,
                    "common_name": normalize_space(
                        self._first_value(
                            raw,
                            "common_name",
                            "commonName",
                        )
                    ),
                    "synonym_names": self._normalize_names(
                        self._first_value(
                            raw,
                            "synonyms",
                            "synonym_names",
                            "synonymNames",
                        )
                    ),
                    "other_names": self._normalize_names(
                        self._first_value(
                            raw,
                            "other_names",
                            "otherNames",
                            "alternative_names",
                            "alternativeNames",
                        )
                    ),
                },
                "taxonomy": {
                    "superkingdom": lineage.get("superkingdom", ""),
                    "domain": lineage.get("domain", ""),
                    "subkingdom": lineage.get("subkingdom", ""),
                    "superphylum": lineage.get("superphylum", ""),
                    "subphylum": lineage.get("subphylum", ""),
                    "superclass": lineage.get("superclass", ""),
                    "subclass": lineage.get("subclass", ""),
                    "infraclass": lineage.get("infraclass", ""),
                    "superorder": lineage.get("superorder", ""),
                    "suborder": lineage.get("suborder", ""),
                    "infraorder": lineage.get("infraorder", ""),
                    "superfamily": lineage.get("superfamily", ""),
                    "subfamily": lineage.get("subfamily", ""),
                    "tribe": lineage.get("tribe", ""),
                    "subtribe": lineage.get("subtribe", ""),
                    "subgenus": lineage.get("subgenus", ""),
                    "species": lineage.get("species", ""),
                    "subspecies": lineage.get("subspecies", ""),
                    "strain": lineage.get("strain", ""),
                    "isolate": lineage.get("isolate", ""),
                    "clade": lineage.get("clade", ""),
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
                "node_state": {
                    "merged": self._optional_bool(
                        self._first_value(
                            raw,
                            "merged",
                            "is_merged",
                            "isMerged",
                        )
                    ),
                    "merged_into": accepted_provider_id,
                    "deleted": self._optional_bool(
                        self._first_value(
                            raw,
                            "deleted",
                            "is_deleted",
                            "isDeleted",
                        )
                    ),
                    "hidden": self._optional_bool(
                        self._first_value(
                            raw,
                            "hidden",
                            "is_hidden",
                            "isHidden",
                        )
                    ),
                    "active": self._optional_bool(
                        self._first_value(
                            raw,
                            "active",
                            "is_active",
                            "isActive",
                        )
                    ),
                },
                "proteomes": self._normalize_proteomes(
                    self._first_value(
                        raw,
                        "proteomes",
                        "proteome_records",
                        "proteomeRecords",
                    )
                ),
                "hosts": self._normalize_hosts(
                    self._first_value(
                        raw,
                        "hosts",
                        "host_records",
                        "hostRecords",
                    )
                ),
                "genomes": self._normalize_genomes(
                    self._first_value(
                        raw,
                        "genomes",
                        "genome_records",
                        "genomeRecords",
                    )
                ),
                "organism": {
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
                    "serotype": normalize_space(
                        self._first_value(
                            raw,
                            "serotype",
                        )
                    ),
                    "serovar": normalize_space(
                        self._first_value(
                            raw,
                            "serovar",
                        )
                    ),
                    "biotype": normalize_space(
                        self._first_value(
                            raw,
                            "biotype",
                        )
                    ),
                    "pathovar": normalize_space(
                        self._first_value(
                            raw,
                            "pathovar",
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
                "environment": {
                    "marine": self._optional_bool(
                        self._first_value(
                            raw,
                            "marine",
                            "is_marine",
                            "isMarine",
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
                    "host_associated": self._optional_bool(
                        self._first_value(
                            raw,
                            "host_associated",
                            "hostAssociated",
                        )
                    ),
                    "pathogenic": self._optional_bool(
                        self._first_value(
                            raw,
                            "pathogenic",
                            "is_pathogenic",
                            "isPathogenic",
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
        """Extract UniProt and NCBI-style lineage."""

        lineage: dict[str, str] = {
            "superkingdom": normalize_space(raw.get("superkingdom")),
            "domain": normalize_space(raw.get("domain")),
            "kingdom": normalize_space(raw.get("kingdom")),
            "subkingdom": normalize_space(raw.get("subkingdom")),
            "superphylum": normalize_space(raw.get("superphylum")),
            "phylum": normalize_space(raw.get("phylum")),
            "subphylum": normalize_space(raw.get("subphylum")),
            "superclass": normalize_space(raw.get("superclass")),
            "class": normalize_space(raw.get("class")),
            "subclass": normalize_space(raw.get("subclass")),
            "infraclass": normalize_space(raw.get("infraclass")),
            "superorder": normalize_space(raw.get("superorder")),
            "order": normalize_space(raw.get("order")),
            "suborder": normalize_space(raw.get("suborder")),
            "infraorder": normalize_space(raw.get("infraorder")),
            "superfamily": normalize_space(raw.get("superfamily")),
            "family": normalize_space(raw.get("family")),
            "subfamily": normalize_space(raw.get("subfamily")),
            "tribe": normalize_space(raw.get("tribe")),
            "subtribe": normalize_space(raw.get("subtribe")),
            "genus": normalize_space(raw.get("genus")),
            "subgenus": normalize_space(raw.get("subgenus")),
            "species": normalize_space(raw.get("species")),
            "subspecies": normalize_space(raw.get("subspecies")),
            "strain": normalize_space(raw.get("strain")),
            "isolate": normalize_space(raw.get("isolate")),
            "clade": normalize_space(raw.get("clade")),
        }

        lineage_value = cls._first_value(
            raw,
            "lineage",
            "lineage_nodes",
            "lineageNodes",
            "classification",
        )

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
                        "scientific_name",
                        "scientificName",
                        "name",
                    )
                )
            else:
                rank = ""
                name = normalize_space(item)

            if rank and name and not lineage.get(rank):
                lineage[rank] = name

        if not lineage.get("domain") and lineage.get("superkingdom"):
            lineage["domain"] = lineage["superkingdom"]

        if not lineage.get("kingdom"):
            lineage["kingdom"] = (
                lineage.get("domain")
                or lineage.get("superkingdom")
                or ""
            )

        return lineage

    @classmethod
    def _extract_synonyms(
        cls,
        raw: Mapping[str, Any],
        *,
        scientific_name: str,
        canonical_name: str,
    ) -> list[str]:
        """Extract and deduplicate UniProt taxonomic synonyms."""

        values = cls._list_value(
            cls._first_value(
                raw,
                "synonyms",
                "synonym_names",
                "synonymNames",
                "other_names",
                "otherNames",
                "alternative_names",
                "alternativeNames",
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
                        "value",
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
    def _normalize_names(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize alternate organism names."""

        result: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                name = normalize_space(
                    cls._first_value(
                        item,
                        "name",
                        "value",
                        "scientific_name",
                        "scientificName",
                    )
                )
                name_type = normalize_space(
                    cls._first_value(
                        item,
                        "type",
                        "name_type",
                        "nameType",
                    )
                )
                raw_item = dict(item)
            else:
                name = normalize_space(item)
                name_type = ""
                raw_item = item

            key = (name.casefold(), name_type.casefold())

            if not name or key in seen:
                continue

            seen.add(key)
            result.append(
                {
                    "name": name,
                    "type": name_type,
                    "raw": raw_item,
                }
            )

        return result

    @classmethod
    def _normalize_proteomes(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize UniProt proteome links."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                result.append(
                    {
                        "proteome_id": normalize_space(
                            cls._first_value(
                                item,
                                "proteome_id",
                                "proteomeId",
                                "upid",
                                "id",
                            )
                        ),
                        "name": normalize_space(
                            cls._first_value(
                                item,
                                "name",
                                "proteome_name",
                                "proteomeName",
                            )
                        ),
                        "component": normalize_space(
                            cls._first_value(
                                item,
                                "component",
                                "proteome_component",
                                "proteomeComponent",
                            )
                        ),
                        "busco": normalize_space(
                            cls._first_value(
                                item,
                                "busco",
                                "busco_score",
                                "buscoScore",
                            )
                        ),
                        "protein_count": cls._optional_int(
                            cls._first_value(
                                item,
                                "protein_count",
                                "proteinCount",
                            )
                        ),
                        "reference_proteome": cls._optional_bool(
                            cls._first_value(
                                item,
                                "reference_proteome",
                                "referenceProteome",
                                "is_reference",
                                "isReference",
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
                proteome_id = normalize_space(item)

                if proteome_id:
                    result.append(
                        {
                            "proteome_id": proteome_id,
                            "name": "",
                            "component": "",
                            "busco": "",
                            "protein_count": None,
                            "reference_proteome": None,
                            "url": "",
                            "raw": item,
                        }
                    )

        return result

    @classmethod
    def _normalize_hosts(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize host relationships."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                result.append(
                    {
                        "taxon_id": normalize_space(
                            cls._first_value(
                                item,
                                "taxon_id",
                                "taxonId",
                                "id",
                            )
                        ),
                        "scientific_name": normalize_space(
                            cls._first_value(
                                item,
                                "scientific_name",
                                "scientificName",
                                "name",
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
                        "source": normalize_space(
                            cls._first_value(
                                item,
                                "source",
                                "reference",
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
                            "taxon_id": "",
                            "scientific_name": name,
                            "relationship": "",
                            "source": "",
                            "raw": item,
                        }
                    )

        return result

    @classmethod
    def _normalize_genomes(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize genome and assembly metadata."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                result.append(
                    {
                        "assembly_accession": normalize_space(
                            cls._first_value(
                                item,
                                "assembly_accession",
                                "assemblyAccession",
                                "accession",
                            )
                        ),
                        "biosample_accession": normalize_space(
                            cls._first_value(
                                item,
                                "biosample_accession",
                                "biosampleAccession",
                            )
                        ),
                        "bioproject_accession": normalize_space(
                            cls._first_value(
                                item,
                                "bioproject_accession",
                                "bioprojectAccession",
                            )
                        ),
                        "genome_size": cls._optional_int(
                            cls._first_value(
                                item,
                                "genome_size",
                                "genomeSize",
                            )
                        ),
                        "assembly_level": normalize_space(
                            cls._first_value(
                                item,
                                "assembly_level",
                                "assemblyLevel",
                            )
                        ),
                        "reference": cls._optional_bool(
                            cls._first_value(
                                item,
                                "reference",
                                "is_reference",
                                "isReference",
                            )
                        ),
                        "raw": dict(item),
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
        """Normalize UniProt and external identifiers."""

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
            "taxon_id": "NCBI Taxonomy",
            "taxonId": "NCBI Taxonomy",
            "ncbi_taxon_id": "NCBI Taxonomy",
            "ncbiTaxonId": "NCBI Taxonomy",
            "uniprot_taxonomy_id": "UniProt Taxonomy",
            "uniprotTaxonomyId": "UniProt Taxonomy",
            "proteome_id": "UniProt Proteomes",
            "proteomeId": "UniProt Proteomes",
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
            "biosample_accession": "BioSample",
            "biosampleAccession": "BioSample",
            "bioproject_accession": "BioProject",
            "bioprojectAccession": "BioProject",
            "assembly_accession": "NCBI Assembly",
            "assemblyAccession": "NCBI Assembly",
            "ena_taxon_id": "ENA",
            "enaTaxonId": "ENA",
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
        """Normalize references associated with taxonomy records."""

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
                            item.get("doi")
                        ).removeprefix("https://doi.org/"),
                        "pmid": normalize_space(item.get("pmid")),
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
                            "pmid": "",
                            "url": "",
                            "raw": item,
                        }
                    )

        return result

    @staticmethod
    def _normalize_rank(value: Any) -> str:
        """Normalize NCBI/UniProt taxonomy ranks."""

        rank = normalize_space(value).casefold().replace(
            "_",
            " ",
        ).replace(
            "-",
            " ",
        )

        aliases = {
            "super kingdom": "superkingdom",
            "sub kingdom": "subkingdom",
            "super phylum": "superphylum",
            "sub phylum": "subphylum",
            "super class": "superclass",
            "sub class": "subclass",
            "infra class": "infraclass",
            "super order": "superorder",
            "sub order": "suborder",
            "infra order": "infraorder",
            "super family": "superfamily",
            "sub family": "subfamily",
            "sub tribe": "subtribe",
            "sub genus": "subgenus",
            "sub species": "subspecies",
            "species group": "species_group",
            "species subgroup": "species_subgroup",
            "forma specialis": "forma_specialis",
            "no rank": "unranked",
        }

        if not rank:
            return "unknown"

        return aliases.get(
            rank,
            rank.replace(" ", "_"),
        )

    @staticmethod
    def _normalize_status(
        value: Any,
        *,
        raw: Mapping[str, Any],
    ) -> str:
        """Normalize active, merged, and deleted taxonomy-node states."""

        merged = Provider._optional_bool(
            Provider._first_value(
                raw,
                "merged",
                "is_merged",
                "isMerged",
            )
        )
        deleted = Provider._optional_bool(
            Provider._first_value(
                raw,
                "deleted",
                "is_deleted",
                "isDeleted",
            )
        )
        active = Provider._optional_bool(
            Provider._first_value(
                raw,
                "active",
                "is_active",
                "isActive",
            )
        )

        if deleted:
            return "inactive"

        if merged:
            return "synonym"

        if active is False:
            return "inactive"

        status = normalize_space(value).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "accepted",
            "active": "accepted",
            "current": "accepted",
            "merged": "synonym",
            "secondary": "synonym",
            "deleted": "inactive",
            "inactive": "inactive",
            "hidden": "reference",
            "unclassified": "unknown",
            "unresolved": "unknown",
            "reference": "reference",
        }

        return aliases.get(
            status,
            status or "accepted",
        )

    @staticmethod
    def _decode_cursor(cursor: str | None) -> int:
        if not cursor:
            return 0

        try:
            offset = int(cursor)
        except (TypeError, ValueError) as error:
            raise ProviderError(
                f"Invalid UniProt Taxonomy cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "UniProt Taxonomy cursor must be non-negative."
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
            "current",
        }:
            return True

        if normalized in {
            "0",
            "false",
            "no",
            "n",
            "absent",
            "inactive",
            "deleted",
        }:
            return False

        return None
