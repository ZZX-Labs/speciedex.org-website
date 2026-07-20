#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/natureserve.py

NatureServe provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It does not assume access to an undocumented,
unlicensed, or unstable public API.

Each source record is normalized into the shared Taxon contract while the
complete NatureServe object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "natureserve",
        "path": "static/data/providers/natureserve/taxa.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "NatureServe",
        "source_url": "https://explorer.natureserve.org/"
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
    """File-backed NatureServe provider."""

    PROVIDER_NAME = "natureserve"

    DEFAULT_SOURCE_NAME = "NatureServe"
    DEFAULT_SOURCE_URL = "https://explorer.natureserve.org/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable NatureServe JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"NatureServe export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"NatureServe path is not a file: {source_path}"
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
        """Resolve the configured NatureServe JSONL source path."""

        configured = normalize_space(
            self.definition.get(
                "path"
            )
        )

        if not configured:
            raise ProviderError(
                "NatureServe provider requires a path."
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
        """Normalize one NatureServe species or ecological element record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "element_global_id",
                "elementGlobalId",
                "element_global_uid",
                "elementGlobalUid",
                "unique_id",
                "uniqueId",
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
                "primary_scientific_name",
                "primaryScientificName",
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
                "scientific_name",
                "scientificName",
                "primary_scientific_name",
                "primaryScientificName",
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

        status = self._normalize_taxonomic_status(
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
                "accepted_element_global_id",
                "acceptedElementGlobalId",
                "accepted_id",
                "acceptedId",
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
                "explorer_url",
                "explorerUrl",
            )
        ) or normalize_space(
            self.definition.get(
                "source_url",
                self.DEFAULT_SOURCE_URL,
            )
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
                    "authorship",
                    "author",
                    "scientific_name_authorship",
                    "scientificNameAuthorship",
                )
            ),
            kingdom=lineage.get(
                "kingdom",
                "",
            ),
            phylum=lineage.get(
                "phylum",
                lineage.get(
                    "division",
                    "",
                ),
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
                "programme": "natureserve",
                "reference_only": True,
                "element_global_id": provider_id,
                "accepted_element_global_id": accepted_provider_id,
                "lineage": lineage,
                "parent": {
                    "id": normalize_space(
                        self._first_value(
                            raw,
                            "parent_element_global_id",
                            "parentElementGlobalId",
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
                "element": {
                    "type": normalize_space(
                        self._first_value(
                            raw,
                            "element_type",
                            "elementType",
                            "record_type",
                            "recordType",
                        )
                    ),
                    "subtype": normalize_space(
                        self._first_value(
                            raw,
                            "element_subtype",
                            "elementSubtype",
                        )
                    ),
                    "classification_status": normalize_space(
                        self._first_value(
                            raw,
                            "classification_status",
                            "classificationStatus",
                        )
                    ),
                },
                "conservation": {
                    "global_rank": self._rank_object(
                        raw,
                        prefix="global",
                    ),
                    "national_rank": self._rank_object(
                        raw,
                        prefix="national",
                    ),
                    "subnational_ranks": self._normalize_subnational_ranks(
                        self._first_value(
                            raw,
                            "subnational_ranks",
                            "subnationalRanks",
                            "state_province_ranks",
                            "stateProvinceRanks",
                        )
                    ),
                    "rounded_global_rank": normalize_space(
                        self._first_value(
                            raw,
                            "rounded_global_rank",
                            "roundedGlobalRank",
                            "global_rank_rounded",
                            "globalRankRounded",
                        )
                    ),
                    "iucn_status": normalize_space(
                        self._first_value(
                            raw,
                            "iucn_status",
                            "iucnStatus",
                        )
                    ),
                    "us_esa_status": normalize_space(
                        self._first_value(
                            raw,
                            "us_esa_status",
                            "usEsaStatus",
                            "federal_status",
                            "federalStatus",
                        )
                    ),
                    "cosewic_status": normalize_space(
                        self._first_value(
                            raw,
                            "cosewic_status",
                            "cosewicStatus",
                        )
                    ),
                    "sara_status": normalize_space(
                        self._first_value(
                            raw,
                            "sara_status",
                            "saraStatus",
                        )
                    ),
                    "sensitive": self._optional_bool(
                        self._first_value(
                            raw,
                            "sensitive",
                            "is_sensitive",
                            "isSensitive",
                        )
                    ),
                },
                "distribution": {
                    "countries": self._list_value(
                        self._first_value(
                            raw,
                            "countries",
                            "country",
                        )
                    ),
                    "nations": self._list_value(
                        self._first_value(
                            raw,
                            "nations",
                            "nation",
                        )
                    ),
                    "subnations": self._list_value(
                        self._first_value(
                            raw,
                            "subnations",
                            "subnation",
                            "states_provinces",
                            "statesProvinces",
                        )
                    ),
                    "watersheds": self._list_value(
                        self._first_value(
                            raw,
                            "watersheds",
                            "watershed",
                        )
                    ),
                    "range": self._first_value(
                        raw,
                        "range",
                        "distribution",
                        "geographic_distribution",
                        "geographicDistribution",
                    ),
                },
                "jurisdiction_statuses": self._normalize_jurisdiction_statuses(
                    self._first_value(
                        raw,
                        "jurisdiction_statuses",
                        "jurisdictionStatuses",
                        "occurrence_statuses",
                        "occurrenceStatuses",
                    )
                ),
                "common_names": self._normalize_common_names(
                    self._first_value(
                        raw,
                        "common_names",
                        "commonNames",
                        "vernacular_names",
                        "vernacularNames",
                    ),
                    preferred=normalize_space(
                        self._first_value(
                            raw,
                            "primary_common_name",
                            "primaryCommonName",
                            "common_name",
                            "commonName",
                        )
                    ),
                ),
                "ecology": {
                    "habitats": self._list_value(
                        self._first_value(
                            raw,
                            "habitats",
                            "habitat",
                        )
                    ),
                    "ecological_systems": self._list_value(
                        self._first_value(
                            raw,
                            "ecological_systems",
                            "ecologicalSystems",
                        )
                    ),
                    "communities": self._list_value(
                        self._first_value(
                            raw,
                            "communities",
                            "community",
                        )
                    ),
                    "associations": self._list_value(
                        self._first_value(
                            raw,
                            "associations",
                            "species_associations",
                            "speciesAssociations",
                        )
                    ),
                },
                "population": {
                    "trend": normalize_space(
                        self._first_value(
                            raw,
                            "population_trend",
                            "populationTrend",
                        )
                    ),
                    "abundance": normalize_space(
                        self._first_value(
                            raw,
                            "abundance",
                            "population_abundance",
                            "populationAbundance",
                        )
                    ),
                    "number_of_occurrences": self._optional_int(
                        self._first_value(
                            raw,
                            "number_of_occurrences",
                            "numberOfOccurrences",
                            "occurrence_count",
                            "occurrenceCount",
                        )
                    ),
                },
                "threats": self._normalize_threats(
                    self._first_value(
                        raw,
                        "threats",
                        "threat",
                    )
                ),
                "management": {
                    "needs": self._list_value(
                        self._first_value(
                            raw,
                            "management_needs",
                            "managementNeeds",
                        )
                    ),
                    "research_needs": self._list_value(
                        self._first_value(
                            raw,
                            "research_needs",
                            "researchNeeds",
                        )
                    ),
                    "protection": self._list_value(
                        self._first_value(
                            raw,
                            "protection",
                            "protection_needs",
                            "protectionNeeds",
                        )
                    ),
                },
                "images": self._normalize_images(
                    self._first_value(
                        raw,
                        "images",
                        "image",
                        "media",
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
        """Extract major lineage values."""

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
            "division": normalize_space(
                raw.get(
                    "division"
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
        }

        classification = cls._first_value(
            raw,
            "classification",
            "lineage",
            "higher_taxa",
            "higherTaxa",
        )

        for item in cls._list_value(
            classification
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
        """Extract and deduplicate scientific-name synonyms."""

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
    def _rank_object(
        cls,
        raw: Mapping[str, Any],
        *,
        prefix: str,
    ) -> dict[str, Any]:
        """Build a normalized global or national rank object."""

        snake = prefix
        camel = (
            prefix[0].lower()
            + prefix[1:]
        )

        return {
            "rank": normalize_space(
                cls._first_value(
                    raw,
                    f"{snake}_rank",
                    f"{camel}Rank",
                )
            ),
            "rounded_rank": normalize_space(
                cls._first_value(
                    raw,
                    f"rounded_{snake}_rank",
                    f"rounded{prefix.title()}Rank",
                    f"{snake}_rank_rounded",
                    f"{camel}RankRounded",
                )
            ),
            "review_date": normalize_space(
                cls._first_value(
                    raw,
                    f"{snake}_rank_review_date",
                    f"{camel}RankReviewDate",
                )
            ),
            "change_date": normalize_space(
                cls._first_value(
                    raw,
                    f"{snake}_rank_change_date",
                    f"{camel}RankChangeDate",
                )
            ),
            "reasons": cls._list_value(
                cls._first_value(
                    raw,
                    f"{snake}_rank_reasons",
                    f"{camel}RankReasons",
                )
            ),
        }

    @classmethod
    def _normalize_subnational_ranks(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize state, province, and territory conservation ranks."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(
            value
        ):
            if not isinstance(
                item,
                Mapping,
            ):
                continue

            entry = dict(
                item
            )

            entry.update(
                {
                    "jurisdiction": normalize_space(
                        cls._first_value(
                            item,
                            "jurisdiction",
                            "subnation",
                            "state",
                            "province",
                            "code",
                        )
                    ),
                    "rank": normalize_space(
                        cls._first_value(
                            item,
                            "rank",
                            "subnational_rank",
                            "subnationalRank",
                        )
                    ),
                    "rounded_rank": normalize_space(
                        cls._first_value(
                            item,
                            "rounded_rank",
                            "roundedRank",
                        )
                    ),
                    "review_date": normalize_space(
                        cls._first_value(
                            item,
                            "review_date",
                            "reviewDate",
                        )
                    ),
                }
            )

            result.append(
                entry
            )

        return result

    @classmethod
    def _normalize_jurisdiction_statuses(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize presence, origin, and regularity by jurisdiction."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(
            value
        ):
            if not isinstance(
                item,
                Mapping,
            ):
                continue

            entry = dict(
                item
            )

            entry.update(
                {
                    "jurisdiction": normalize_space(
                        cls._first_value(
                            item,
                            "jurisdiction",
                            "nation",
                            "subnation",
                            "code",
                        )
                    ),
                    "presence": normalize_space(
                        cls._first_value(
                            item,
                            "presence",
                            "occurrence_status",
                            "occurrenceStatus",
                        )
                    ),
                    "origin": normalize_space(
                        cls._first_value(
                            item,
                            "origin",
                            "native_status",
                            "nativeStatus",
                        )
                    ),
                    "regularity": normalize_space(
                        cls._first_value(
                            item,
                            "regularity",
                        )
                    ),
                }
            )

            result.append(
                entry
            )

        return result

    @classmethod
    def _normalize_common_names(
        cls,
        value: Any,
        *,
        preferred: str,
    ) -> list[dict[str, Any]]:
        """Normalize common names with language and preferred flags."""

        values = cls._list_value(
            value
        )

        if preferred:
            values.insert(
                0,
                {
                    "name": preferred,
                    "preferred": True,
                },
            )

        result: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()

        for item in values:
            if isinstance(
                item,
                Mapping,
            ):
                name = normalize_space(
                    cls._first_value(
                        item,
                        "name",
                        "common_name",
                        "commonName",
                    )
                )

                language = normalize_space(
                    cls._first_value(
                        item,
                        "language",
                        "lang",
                        "locale",
                    )
                )

                preferred_value = cls._optional_bool(
                    cls._first_value(
                        item,
                        "preferred",
                        "is_preferred",
                        "isPreferred",
                    )
                )

                raw = dict(
                    item
                )
            else:
                name = normalize_space(
                    item
                )
                language = ""
                preferred_value = None
                raw = item

            key = (
                name.casefold(),
                language.casefold(),
            )

            if (
                not name
                or key in seen
            ):
                continue

            seen.add(
                key
            )

            result.append(
                {
                    "name": name,
                    "language": language,
                    "preferred": preferred_value,
                    "raw": raw,
                }
            )

        return result

    @classmethod
    def _normalize_threats(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize threat scope, severity, and timing."""

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
                        "name": normalize_space(
                            cls._first_value(
                                item,
                                "name",
                                "threat",
                                "title",
                            )
                        ),
                        "scope": normalize_space(
                            cls._first_value(
                                item,
                                "scope",
                            )
                        ),
                        "severity": normalize_space(
                            cls._first_value(
                                item,
                                "severity",
                            )
                        ),
                        "timing": normalize_space(
                            cls._first_value(
                                item,
                                "timing",
                            )
                        ),
                    }
                )

                result.append(
                    entry
                )
            else:
                name = normalize_space(
                    item
                )

                if name:
                    result.append(
                        {
                            "name": name,
                            "scope": "",
                            "severity": "",
                            "timing": "",
                        }
                    )

        return result

    @classmethod
    def _normalize_images(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize image metadata and rights."""

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
                                "image_url",
                                "imageUrl",
                                "identifier",
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
                        "creator": normalize_space(
                            cls._first_value(
                                item,
                                "creator",
                                "photographer",
                                "author",
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
                    "thumbnail_url": "",
                    "creator": "",
                    "license": "",
                }

            if (
                entry.get(
                    "url"
                )
                or entry.get(
                    "thumbnail_url"
                )
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
        """Normalize external taxonomy and conservation identifiers."""

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
        """Normalize NatureServe references and citations."""

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
            "division": "phylum",
            "sub division": "subphylum",
            "sub species": "subspecies",
            "sub genus": "subgenus",
            "sub family": "subfamily",
            "sub order": "suborder",
            "sub class": "subclass",
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
    def _normalize_taxonomic_status(
        value: Any,
    ) -> str:
        """Normalize NatureServe taxonomic status labels."""

        status = normalize_space(
            value
        ).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "valid",
            "synonym": "synonym",
            "unaccepted": "synonym",
            "misapplied": "misapplied",
            "provisional": "provisionally accepted",
            "questionable": "unknown",
            "doubtful": "unknown",
            "inactive": "inactive",
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
                f"Invalid NatureServe cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "NatureServe cursor must be non-negative."
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
