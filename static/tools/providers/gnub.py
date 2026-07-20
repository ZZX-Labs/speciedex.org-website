#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/gnub.py

Global Names Usage Bank (GNUB) provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It is intended for scientific-name usages, taxonomic
concepts, canonical names, authorship, accepted-name relationships, parent
usages, classifications, nomenclatural status, synonymy, references,
provenance, and external identifiers.

Each source record is normalized into the shared Speciedex Taxon contract while
the complete GNUB source object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "gnub",
        "path": "static/data/providers/gnub/name-usages.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "Global Names Usage Bank",
        "source_url": "https://verifier.globalnames.org/"
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
    """File-backed Global Names Usage Bank provider."""

    PROVIDER_NAME = "gnub"

    DEFAULT_SOURCE_NAME = "Global Names Usage Bank"
    DEFAULT_SOURCE_URL = "https://verifier.globalnames.org/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable GNUB JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"GNUB export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"GNUB path is not a file: {source_path}"
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
                            f"Invalid GNUB JSON at "
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
        """Resolve the configured GNUB JSONL source path."""

        configured = normalize_space(
            self.definition.get("path")
            or self.definition.get("file")
            or self.definition.get("source_path")
        )

        if not configured:
            raise ProviderError(
                "GNUB provider requires a path."
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
        """Normalize one GNUB scientific-name usage."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "name_usage_id",
                "nameUsageId",
                "name_usage_uuid",
                "nameUsageUuid",
                "usage_id",
                "usageId",
                "uuid",
                "id",
            )
        )

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "name_string",
                "nameString",
                "verbatim_name",
                "verbatimName",
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
                "canonical_form",
                "canonicalForm",
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
                "usage_status",
                "usageStatus",
            )
        )

        accepted_provider_id = normalize_space(
            self._first_value(
                raw,
                "accepted_name_usage_id",
                "acceptedNameUsageId",
                "acceptedNameUsageID",
                "accepted_usage_id",
                "acceptedUsageId",
                "accepted_taxon_id",
                "acceptedTaxonId",
                "accepted_id",
                "acceptedId",
            )
        )

        if accepted_provider_id == provider_id:
            accepted_provider_id = ""

        parent_provider_id = normalize_space(
            self._first_value(
                raw,
                "parent_name_usage_id",
                "parentNameUsageId",
                "parentNameUsageID",
                "parent_usage_id",
                "parentUsageId",
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
            source_url = f"{base}/name_usage/{provider_id}"

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
                    "author",
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
                "programme": "gnub",
                "reference_only": True,
                "name_usage_id": provider_id,
                "accepted_name_usage_id": accepted_provider_id,
                "parent_name_usage_id": parent_provider_id,
                "lineage": lineage,
                "parent": {
                    "id": parent_provider_id,
                    "name": normalize_space(
                        self._first_value(
                            raw,
                            "parent_name_usage",
                            "parentNameUsage",
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
                    "verbatim": normalize_space(
                        self._first_value(
                            raw,
                            "verbatim_name",
                            "verbatimName",
                            "name_string",
                            "nameString",
                        )
                    ),
                    "canonical": canonical_name,
                    "normalized": normalize_space(
                        self._first_value(
                            raw,
                            "normalized_name",
                            "normalizedName",
                        )
                    ),
                    "genus": normalize_space(
                        self._first_value(
                            raw,
                            "genus",
                            "genus_name",
                            "genusName",
                        )
                    ),
                    "specific_epithet": normalize_space(
                        self._first_value(
                            raw,
                            "specific_epithet",
                            "specificEpithet",
                            "species",
                        )
                    ),
                    "infraspecific_epithet": normalize_space(
                        self._first_value(
                            raw,
                            "infraspecific_epithet",
                            "infraspecificEpithet",
                            "subspecies",
                            "variety",
                            "form",
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
                    "hybrid_marker": normalize_space(
                        self._first_value(
                            raw,
                            "hybrid_marker",
                            "hybridMarker",
                        )
                    ),
                    "cultivar_epithet": normalize_space(
                        self._first_value(
                            raw,
                            "cultivar_epithet",
                            "cultivarEpithet",
                        )
                    ),
                },
                "usage": {
                    "usage_type": normalize_space(
                        self._first_value(
                            raw,
                            "usage_type",
                            "usageType",
                            "name_usage_type",
                            "nameUsageType",
                        )
                    ),
                    "usage_status": normalize_space(
                        self._first_value(
                            raw,
                            "usage_status",
                            "usageStatus",
                        )
                    ),
                    "taxonomic_status": normalize_space(
                        self._first_value(
                            raw,
                            "taxonomic_status",
                            "taxonomicStatus",
                        )
                    ),
                    "name_according_to": normalize_space(
                        self._first_value(
                            raw,
                            "name_according_to",
                            "nameAccordingTo",
                            "according_to",
                            "accordingTo",
                        )
                    ),
                    "name_according_to_id": normalize_space(
                        self._first_value(
                            raw,
                            "name_according_to_id",
                            "nameAccordingToId",
                            "nameAccordingToID",
                        )
                    ),
                    "concept_label": normalize_space(
                        self._first_value(
                            raw,
                            "concept_label",
                            "conceptLabel",
                        )
                    ),
                    "concept_notes": normalize_space(
                        self._first_value(
                            raw,
                            "concept_notes",
                            "conceptNotes",
                            "taxonomic_notes",
                            "taxonomicNotes",
                        )
                    ),
                },
                "nomenclature": {
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
                            "code",
                        )
                    ),
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
                    "original_combination": normalize_space(
                        self._first_value(
                            raw,
                            "original_combination",
                            "originalCombination",
                            "original_name",
                            "originalName",
                        )
                    ),
                    "original_combination_id": normalize_space(
                        self._first_value(
                            raw,
                            "original_combination_id",
                            "originalCombinationId",
                            "original_name_id",
                            "originalNameId",
                        )
                    ),
                    "publication": normalize_space(
                        self._first_value(
                            raw,
                            "name_published_in",
                            "namePublishedIn",
                            "publication",
                            "published_in",
                            "publishedIn",
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
                    "replacement_name": normalize_space(
                        self._first_value(
                            raw,
                            "replacement_name",
                            "replacementName",
                        )
                    ),
                },
                "classification": self._normalize_classification(
                    self._first_value(
                        raw,
                        "classification",
                        "lineage",
                        "higher_taxa",
                        "higherTaxa",
                    )
                ),
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
                "relationships": self._normalize_relationships(
                    self._first_value(
                        raw,
                        "relationships",
                        "relations",
                        "name_usage_relationships",
                        "nameUsageRelationships",
                    )
                ),
                "data_source": {
                    "data_source_id": normalize_space(
                        self._first_value(
                            raw,
                            "data_source_id",
                            "dataSourceId",
                            "dataset_id",
                            "datasetId",
                        )
                    ),
                    "data_source_title": normalize_space(
                        self._first_value(
                            raw,
                            "data_source_title",
                            "dataSourceTitle",
                            "dataset_title",
                            "datasetTitle",
                            "dataset_name",
                            "datasetName",
                        )
                    ),
                    "data_source_url": normalize_space(
                        self._first_value(
                            raw,
                            "data_source_url",
                            "dataSourceUrl",
                            "dataset_url",
                            "datasetUrl",
                        )
                    ),
                    "record_id": normalize_space(
                        self._first_value(
                            raw,
                            "data_source_record_id",
                            "dataSourceRecordId",
                            "source_record_id",
                            "sourceRecordId",
                        )
                    ),
                    "imported_at": normalize_space(
                        self._first_value(
                            raw,
                            "imported_at",
                            "importedAt",
                        )
                    ),
                },
                "verification": {
                    "verified": self._optional_bool(
                        self._first_value(
                            raw,
                            "verified",
                            "is_verified",
                            "isVerified",
                        )
                    ),
                    "verification_score": self._optional_float(
                        self._first_value(
                            raw,
                            "verification_score",
                            "verificationScore",
                            "score",
                        )
                    ),
                    "match_type": normalize_space(
                        self._first_value(
                            raw,
                            "match_type",
                            "matchType",
                        )
                    ),
                    "match_edit_distance": self._optional_int(
                        self._first_value(
                            raw,
                            "match_edit_distance",
                            "matchEditDistance",
                            "edit_distance",
                            "editDistance",
                        )
                    ),
                    "match_notes": normalize_space(
                        self._first_value(
                            raw,
                            "match_notes",
                            "matchNotes",
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
    ) -> dict[str, str]:
        """Extract classification from direct or nested fields."""

        lineage = {
            "domain": normalize_space(
                cls._first_value(
                    raw,
                    "domain",
                    "superkingdom",
                )
            ),
            "kingdom": normalize_space(raw.get("kingdom")),
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
            "genus": normalize_space(raw.get("genus")),
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
                    "canonical_name",
                    "canonicalName",
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
        """Extract and deduplicate synonym names."""

        values = cls._list_value(
            cls._first_value(
                raw,
                "synonyms",
                "synonym",
                "synonym_records",
                "synonymRecords",
                "taxonomic_synonyms",
                "taxonomicSynonyms",
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
                        "name_string",
                        "nameString",
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
    def _normalize_classification(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize ordered classification entries."""

        result: list[dict[str, Any]] = []

        for index, item in enumerate(cls._list_value(value)):
            if not isinstance(item, Mapping):
                name = normalize_space(item)

                if name:
                    result.append(
                        {
                            "rank": "unknown",
                            "name": name,
                            "usage_id": "",
                            "position": index,
                            "raw": item,
                        }
                    )
                continue

            entry = {
                "rank": cls._normalize_rank(
                    cls._first_value(
                        item,
                        "rank",
                        "taxon_rank",
                        "taxonRank",
                    )
                ),
                "name": normalize_space(
                    cls._first_value(
                        item,
                        "name",
                        "scientific_name",
                        "scientificName",
                        "canonical_name",
                        "canonicalName",
                    )
                ),
                "usage_id": normalize_space(
                    cls._first_value(
                        item,
                        "usage_id",
                        "usageId",
                        "name_usage_id",
                        "nameUsageId",
                        "id",
                    )
                ),
                "position": cls._optional_int(
                    cls._first_value(
                        item,
                        "position",
                        "order",
                    )
                ),
                "raw": dict(item),
            }

            if entry["position"] is None:
                entry["position"] = index

            if entry["name"] or entry["usage_id"]:
                result.append(entry)

        return result

    @classmethod
    def _normalize_synonym_records(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize synonym name usages."""

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
                                "name_string",
                                "nameString",
                            )
                        ),
                        "usage_id": normalize_space(
                            cls._first_value(
                                item,
                                "usage_id",
                                "usageId",
                                "name_usage_id",
                                "nameUsageId",
                                "id",
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
                                "published_in",
                                "publishedIn",
                            )
                        ),
                    }
                )

                if entry.get("name") or entry.get("usage_id"):
                    result.append(entry)
            else:
                name = normalize_space(item)

                if name:
                    result.append(
                        {
                            "name": name,
                            "usage_id": "",
                            "authorship": "",
                            "status": "synonym",
                            "relationship": "",
                            "reference": "",
                        }
                    )

        return result

    @classmethod
    def _normalize_relationships(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize name-usage and taxonomic relationships."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if not isinstance(item, Mapping):
                relationship = normalize_space(item)

                if relationship:
                    result.append(
                        {
                            "type": relationship,
                            "subject_id": "",
                            "object_id": "",
                            "subject_name": "",
                            "object_name": "",
                            "reference": "",
                            "raw": item,
                        }
                    )
                continue

            result.append(
                {
                    "type": normalize_space(
                        cls._first_value(
                            item,
                            "type",
                            "relationship",
                            "relation",
                        )
                    ),
                    "subject_id": normalize_space(
                        cls._first_value(
                            item,
                            "subject_id",
                            "subjectId",
                            "from_id",
                            "fromId",
                        )
                    ),
                    "object_id": normalize_space(
                        cls._first_value(
                            item,
                            "object_id",
                            "objectId",
                            "to_id",
                            "toId",
                        )
                    ),
                    "subject_name": normalize_space(
                        cls._first_value(
                            item,
                            "subject_name",
                            "subjectName",
                            "from_name",
                            "fromName",
                        )
                    ),
                    "object_name": normalize_space(
                        cls._first_value(
                            item,
                            "object_name",
                            "objectName",
                            "to_name",
                            "toName",
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

        return result

    @classmethod
    def _normalize_identifiers(
        cls,
        value: Any,
        *,
        raw: Mapping[str, Any],
    ) -> list[dict[str, str]]:
        """Normalize GNUB and external identifiers."""

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
            "name_usage_id": "GNUB",
            "nameUsageId": "GNUB",
            "name_usage_uuid": "GNUB",
            "nameUsageUuid": "GNUB",
            "global_names_id": "Global Names",
            "globalNamesId": "Global Names",
            "gbif_id": "GBIF",
            "gbifId": "GBIF",
            "itis_tsn": "ITIS",
            "itisTsn": "ITIS",
            "worms_id": "WoRMS",
            "wormsId": "WoRMS",
            "ipni_id": "IPNI",
            "ipniId": "IPNI",
            "zoobank_lsid": "ZooBank",
            "zoobankLsid": "ZooBank",
            "ncbi_taxid": "NCBI Taxonomy",
            "ncbiTaxid": "NCBI Taxonomy",
            "col_id": "Catalogue of Life",
            "colId": "Catalogue of Life",
            "wikidata_id": "Wikidata",
            "wikidataId": "Wikidata",
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
        """Normalize usage and nomenclatural references."""

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
                        "reference_id": normalize_space(
                            cls._first_value(
                                item,
                                "reference_id",
                                "referenceId",
                                "id",
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
                            "reference_id": "",
                        }
                    )

        return result

    @staticmethod
    def _normalize_rank(value: Any) -> str:
        """Normalize cross-code taxonomic ranks."""

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
            "division": "phylum",
            "sub division": "subphylum",
            "subdivision": "subphylum",
            "sub species": "subspecies",
            "sub genus": "subgenus",
            "sub family": "subfamily",
            "sub tribe": "subtribe",
            "sub order": "suborder",
            "sub class": "subclass",
            "sub phylum": "subphylum",
            "super family": "superfamily",
            "super order": "superorder",
            "var.": "variety",
            "subvar.": "subvariety",
            "forma": "form",
            "f.": "form",
            "no rank": "unranked",
            "species group": "species_group",
            "species subgroup": "species_subgroup",
        }

        if not rank:
            return "unknown"

        return aliases.get(
            rank,
            rank.replace(" ", "_"),
        )

    @staticmethod
    def _normalize_status(value: Any) -> str:
        """Normalize taxonomic and nomenclatural statuses."""

        status = normalize_space(value).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "valid",
            "current": "accepted",
            "correct name": "accepted",
            "provisionally accepted": "provisionally accepted",
            "provisional": "provisionally accepted",
            "synonym": "synonym",
            "junior synonym": "synonym",
            "heterotypic synonym": "synonym",
            "homotypic synonym": "synonym",
            "objective synonym": "synonym",
            "subjective synonym": "synonym",
            "unaccepted": "synonym",
            "misapplied": "misapplied",
            "homonym": "excluded",
            "nomen nudum": "excluded",
            "unavailable": "excluded",
            "invalid": "excluded",
            "illegitimate": "excluded",
            "suppressed": "excluded",
            "nomen dubium": "unknown",
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
                f"Invalid GNUB cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "GNUB cursor must be non-negative."
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
            "verified",
        }:
            return True

        if normalized in {
            "0",
            "false",
            "no",
            "n",
            "unverified",
        }:
            return False

        return None
