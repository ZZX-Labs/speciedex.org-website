#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/molluscabase.py

MolluscaBase provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It is intended for MolluscaBase taxonomy, Aphia
identifiers, accepted names, synonymy, full molluscan classification,
nomenclature, marine/freshwater/terrestrial environment flags, distributions,
traits, references, external identifiers, and provenance metadata.

Each source record is normalized into the shared Speciedex Taxon contract while
the complete MolluscaBase source object is preserved under
``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "molluscabase",
        "path": "static/data/providers/molluscabase/taxa.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "MolluscaBase",
        "source_url": "https://www.molluscabase.org/"
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
    """File-backed MolluscaBase provider."""

    PROVIDER_NAME = "molluscabase"

    DEFAULT_SOURCE_NAME = "MolluscaBase"
    DEFAULT_SOURCE_URL = "https://www.molluscabase.org/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable MolluscaBase JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"MolluscaBase export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"MolluscaBase path is not a file: {source_path}"
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
                            f"Invalid MolluscaBase JSON at "
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
        """Resolve the configured MolluscaBase JSONL source path."""

        configured = normalize_space(
            self.definition.get("path")
            or self.definition.get("file")
            or self.definition.get("source_path")
        )

        if not configured:
            raise ProviderError(
                "MolluscaBase provider requires a path."
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
        """Normalize one MolluscaBase taxon record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "aphia_id",
                "AphiaID",
                "aphiaId",
                "molluscabase_id",
                "molluscabaseId",
                "taxon_id",
                "taxonId",
                "id",
            )
        )

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "valid_name",
                "validName",
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
                "valid_name",
                "validName",
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
                "validity",
            )
        )

        accepted_provider_id = normalize_space(
            self._first_value(
                raw,
                "valid_aphia_id",
                "validAphiaID",
                "validAphiaId",
                "accepted_name_id",
                "acceptedNameId",
                "accepted_taxon_id",
                "acceptedTaxonId",
            )
        )

        if accepted_provider_id == provider_id:
            accepted_provider_id = ""

        parent_provider_id = normalize_space(
            self._first_value(
                raw,
                "parent_aphia_id",
                "parentAphiaID",
                "parentAphiaId",
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
            source_url = (
                f"{base}/aphia.php?p=taxdetails&id={provider_id}"
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
                    "authority",
                    "authorship",
                    "scientific_name_authorship",
                    "scientificNameAuthorship",
                )
            ),
            kingdom=lineage.get("kingdom", "Animalia"),
            phylum=lineage.get("phylum", "Mollusca"),
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
                "programme": "molluscabase",
                "reference_only": True,
                "aphia_id": provider_id,
                "valid_aphia_id": accepted_provider_id,
                "lineage": lineage,
                "parent": {
                    "aphia_id": parent_provider_id,
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
                    "valid_name": normalize_space(
                        self._first_value(
                            raw,
                            "valid_name",
                            "validName",
                        )
                    ),
                    "valid_authority": normalize_space(
                        self._first_value(
                            raw,
                            "valid_authority",
                            "validAuthority",
                        )
                    ),
                    "unaccept_reason": normalize_space(
                        self._first_value(
                            raw,
                            "unaccept_reason",
                            "unacceptReason",
                        )
                    ),
                    "original_name": normalize_space(
                        self._first_value(
                            raw,
                            "original_name",
                            "originalName",
                            "original_combination",
                            "originalCombination",
                        )
                    ),
                    "original_aphia_id": normalize_space(
                        self._first_value(
                            raw,
                            "original_aphia_id",
                            "originalAphiaID",
                            "originalAphiaId",
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
                },
                "nomenclature": {
                    "nomenclatural_code": normalize_space(
                        self._first_value(
                            raw,
                            "nomenclatural_code",
                            "nomenclaturalCode",
                        )
                    ) or "ICZN",
                    "nomenclatural_status": normalize_space(
                        self._first_value(
                            raw,
                            "nomenclatural_status",
                            "nomenclaturalStatus",
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
                    "homonym": self._optional_bool(
                        self._first_value(
                            raw,
                            "homonym",
                            "is_homonym",
                            "isHomonym",
                        )
                    ),
                    "original_description": normalize_space(
                        self._first_value(
                            raw,
                            "original_description",
                            "originalDescription",
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
                    "taxonomic_notes": normalize_space(
                        self._first_value(
                            raw,
                            "taxonomic_notes",
                            "taxonomicNotes",
                            "remarks",
                        )
                    ),
                },
                "synonym_records": self._normalize_synonym_records(
                    self._first_value(
                        raw,
                        "synonyms",
                        "synonym_records",
                        "synonymRecords",
                    )
                ),
                "vernacular_names": self._normalize_vernacular_names(
                    self._first_value(
                        raw,
                        "vernacular_names",
                        "vernacularNames",
                        "common_names",
                        "commonNames",
                    )
                ),
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
                    "brackish": self._optional_bool(
                        self._first_value(
                            raw,
                            "brackish",
                            "is_brackish",
                            "isBrackish",
                        )
                    ),
                    "extinct": self._optional_bool(
                        self._first_value(
                            raw,
                            "extinct",
                            "is_extinct",
                            "isExtinct",
                        )
                    ),
                },
                "distribution": self._normalize_distribution(
                    self._first_value(
                        raw,
                        "distribution",
                        "distributions",
                        "distribution_records",
                        "distributionRecords",
                    )
                ),
                "traits": self._normalize_traits(
                    self._first_value(
                        raw,
                        "traits",
                        "attributes",
                        "biological_traits",
                        "biologicalTraits",
                    )
                ),
                "ecology": {
                    "habitats": self._list_value(
                        self._first_value(
                            raw,
                            "habitats",
                            "habitat",
                        )
                    ),
                    "depth_min_m": self._optional_float(
                        self._first_value(
                            raw,
                            "depth_min_m",
                            "depthMinM",
                            "minimum_depth",
                            "minimumDepth",
                        )
                    ),
                    "depth_max_m": self._optional_float(
                        self._first_value(
                            raw,
                            "depth_max_m",
                            "depthMaxM",
                            "maximum_depth",
                            "maximumDepth",
                        )
                    ),
                    "feeding_type": normalize_space(
                        self._first_value(
                            raw,
                            "feeding_type",
                            "feedingType",
                        )
                    ),
                    "mobility": normalize_space(
                        self._first_value(
                            raw,
                            "mobility",
                        )
                    ),
                    "substrate": normalize_space(
                        self._first_value(
                            raw,
                            "substrate",
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
                        "sources",
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
    ) -> dict[str, str]:
        """Extract full MolluscaBase classification."""

        lineage = {
            "kingdom": normalize_space(raw.get("kingdom")) or "Animalia",
            "phylum": normalize_space(raw.get("phylum")) or "Mollusca",
            "subphylum": normalize_space(raw.get("subphylum")),
            "class": normalize_space(raw.get("class")),
            "subclass": normalize_space(raw.get("subclass")),
            "order": normalize_space(raw.get("order")),
            "suborder": normalize_space(raw.get("suborder")),
            "superfamily": normalize_space(raw.get("superfamily")),
            "family": normalize_space(raw.get("family")),
            "subfamily": normalize_space(raw.get("subfamily")),
            "genus": normalize_space(raw.get("genus")),
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
                "synonym_records",
                "synonymRecords",
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
        """Normalize MolluscaBase synonym records."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                entry = dict(item)
                entry.update(
                    {
                        "aphia_id": normalize_space(
                            cls._first_value(
                                item,
                                "aphia_id",
                                "AphiaID",
                                "aphiaId",
                                "id",
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
                        "authority": normalize_space(
                            cls._first_value(
                                item,
                                "authority",
                                "authorship",
                            )
                        ),
                        "status": cls._normalize_status(
                            cls._first_value(
                                item,
                                "status",
                                "taxonomic_status",
                                "taxonomicStatus",
                            )
                        ),
                        "unaccept_reason": normalize_space(
                            cls._first_value(
                                item,
                                "unaccept_reason",
                                "unacceptReason",
                            )
                        ),
                        "reference": normalize_space(
                            cls._first_value(
                                item,
                                "reference",
                                "citation",
                            )
                        ),
                    }
                )

                if entry.get("name") or entry.get("aphia_id"):
                    result.append(entry)
            else:
                name = normalize_space(item)

                if name:
                    result.append(
                        {
                            "aphia_id": "",
                            "name": name,
                            "authority": "",
                            "status": "synonym",
                            "unaccept_reason": "",
                            "reference": "",
                        }
                    )

        return result

    @classmethod
    def _normalize_vernacular_names(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize multilingual vernacular names."""

        result: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                name = normalize_space(
                    cls._first_value(
                        item,
                        "name",
                        "vernacular_name",
                        "vernacularName",
                        "common_name",
                        "commonName",
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
                preferred = None
                raw_item = item

            key = (name.casefold(), language.casefold())

            if not name or key in seen:
                continue

            seen.add(key)
            result.append(
                {
                    "name": name,
                    "language": language,
                    "preferred": preferred,
                    "raw": raw_item,
                }
            )

        return result

    @classmethod
    def _normalize_distribution(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize geographic and marine distribution records."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                result.append(
                    {
                        "location": normalize_space(
                            cls._first_value(
                                item,
                                "location",
                                "name",
                                "area",
                                "region",
                            )
                        ),
                        "location_id": normalize_space(
                            cls._first_value(
                                item,
                                "location_id",
                                "locationId",
                                "mrgid",
                                "MRGID",
                            )
                        ),
                        "status": normalize_space(
                            cls._first_value(
                                item,
                                "status",
                                "occurrence_status",
                                "occurrenceStatus",
                            )
                        ),
                        "type": normalize_space(
                            cls._first_value(
                                item,
                                "type",
                                "distribution_type",
                                "distributionType",
                            )
                        ),
                        "latitude": cls._optional_float(
                            cls._first_value(
                                item,
                                "latitude",
                                "lat",
                            )
                        ),
                        "longitude": cls._optional_float(
                            cls._first_value(
                                item,
                                "longitude",
                                "lon",
                                "lng",
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
                location = normalize_space(item)

                if location:
                    result.append(
                        {
                            "location": location,
                            "location_id": "",
                            "status": "",
                            "type": "",
                            "latitude": None,
                            "longitude": None,
                            "source": "",
                            "raw": item,
                        }
                    )

        return result

    @classmethod
    def _normalize_traits(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize biological and ecological traits."""

        result: list[dict[str, Any]] = []

        if isinstance(value, Mapping):
            value = [
                {
                    "name": key,
                    "value": item,
                }
                for key, item in value.items()
            ]

        for item in cls._list_value(value):
            if not isinstance(item, Mapping):
                continue

            result.append(
                {
                    "name": normalize_space(
                        cls._first_value(
                            item,
                            "name",
                            "trait",
                            "attribute",
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
                            "units",
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

        return result

    @classmethod
    def _normalize_identifiers(
        cls,
        value: Any,
        *,
        raw: Mapping[str, Any],
    ) -> list[dict[str, str]]:
        """Normalize MolluscaBase and external identifiers."""

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
            "aphia_id": "MolluscaBase",
            "AphiaID": "MolluscaBase",
            "aphiaId": "MolluscaBase",
            "worms_id": "WoRMS",
            "wormsId": "WoRMS",
            "gbif_id": "GBIF",
            "gbifId": "GBIF",
            "itis_tsn": "ITIS",
            "itisTsn": "ITIS",
            "col_id": "Catalogue of Life",
            "colId": "Catalogue of Life",
            "ncbi_taxid": "NCBI Taxonomy",
            "ncbiTaxid": "NCBI Taxonomy",
            "wikidata_id": "Wikidata",
            "wikidataId": "Wikidata",
            "eol_id": "Encyclopedia of Life",
            "eolId": "Encyclopedia of Life",
            "bold_id": "BOLD",
            "boldId": "BOLD",
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
        """Normalize MolluscaBase references."""

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
                        "url": normalize_space(
                            cls._first_value(
                                item,
                                "url",
                                "source_url",
                                "sourceUrl",
                            )
                        ),
                        "aphia_source_id": normalize_space(
                            cls._first_value(
                                item,
                                "aphia_source_id",
                                "aphiaSourceId",
                                "source_id",
                                "sourceId",
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
                            "url": "",
                            "aphia_source_id": "",
                            "raw": item,
                        }
                    )

        return result

    @classmethod
    def _normalize_media(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize images and other media."""

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
        """Normalize MolluscaBase taxonomic ranks."""

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
        """Normalize MolluscaBase taxonomic status."""

        status = normalize_space(value).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "accepted",
            "current": "accepted",
            "unaccepted": "synonym",
            "synonym": "synonym",
            "alternate representation": "synonym",
            "superseded combination": "synonym",
            "junior synonym": "synonym",
            "objective synonym": "synonym",
            "subjective synonym": "synonym",
            "nomen dubium": "unknown",
            "taxon inquirendum": "unknown",
            "temporary name": "provisionally accepted",
            "misapplied": "misapplied",
            "excluded": "excluded",
            "nomen nudum": "excluded",
            "unavailable": "excluded",
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
                f"Invalid MolluscaBase cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "MolluscaBase cursor must be non-negative."
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
