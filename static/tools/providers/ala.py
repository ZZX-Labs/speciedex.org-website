#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/ala.py

Atlas of Living Australia provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It does not assume access to an undocumented,
unlicensed, or unstable public API.

Each source object is normalized into the shared Taxon contract while the
complete Atlas of Living Australia record is preserved under
``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "ala",
        "path": "static/data/providers/ala/taxa.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "Atlas of Living Australia",
        "source_url": "https://bie.ala.org.au/"
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
    """File-backed Atlas of Living Australia provider."""

    PROVIDER_NAME = "ala"

    DEFAULT_SOURCE_NAME = "Atlas of Living Australia"
    DEFAULT_SOURCE_URL = "https://bie.ala.org.au/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable ALA JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"Atlas of Living Australia export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"Atlas of Living Australia path is not a file: {source_path}"
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
        """Resolve the configured JSONL source path."""

        configured = normalize_space(
            self.definition.get(
                "path"
            )
        )

        if not configured:
            raise ProviderError(
                "Atlas of Living Australia provider requires a path."
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
        """Normalize one ALA taxon or species-profile record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "guid",
                "taxon_guid",
                "taxonGuid",
                "taxon_id",
                "taxonId",
                "taxonID",
                "lsid",
                "id",
            )
        )

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "name",
                "taxon_name",
                "taxonName",
            )
        )

        if not provider_id or not scientific_name:
            return None

        canonical_name = normalize_space(
            self._first_value(
                raw,
                "canonical_name",
                "canonicalName",
                "name_complete",
                "nameComplete",
                "name",
            )
        ) or scientific_name

        rank = normalize_space(
            self._first_value(
                raw,
                "rank",
                "rank_string",
                "rankString",
                "taxon_rank",
                "taxonRank",
            )
        ).casefold() or self._infer_rank(
            canonical_name
        )

        status = self._normalize_status(
            self._first_value(
                raw,
                "status",
                "taxonomic_status",
                "taxonomicStatus",
                "name_status",
                "nameStatus",
            )
        )

        accepted_provider_id = normalize_space(
            self._first_value(
                raw,
                "accepted_guid",
                "acceptedGuid",
                "accepted_taxon_guid",
                "acceptedTaxonGuid",
                "accepted_taxon_id",
                "acceptedTaxonId",
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
                "profile_url",
                "profileUrl",
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
                + "/species/"
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
                    "authorship",
                    "author",
                    "scientific_name_authorship",
                    "scientificNameAuthorship",
                    "name_author",
                    "nameAuthor",
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
                "programme": "atlas_of_living_australia",
                "reference_only": True,
                "taxon_guid": provider_id,
                "accepted_taxon_guid": accepted_provider_id,
                "lsid": normalize_space(
                    self._first_value(
                        raw,
                        "lsid",
                        "guid",
                    )
                ),
                "name_guid": normalize_space(
                    self._first_value(
                        raw,
                        "name_guid",
                        "nameGuid",
                    )
                ),
                "parent": {
                    "guid": normalize_space(
                        self._first_value(
                            raw,
                            "parent_guid",
                            "parentGuid",
                            "parent_taxon_guid",
                            "parentTaxonGuid",
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
                    "rank": normalize_space(
                        self._first_value(
                            raw,
                            "parent_rank",
                            "parentRank",
                        )
                    ).casefold(),
                },
                "lineage": lineage,
                "classification": self._first_mapping(
                    raw,
                    "classification",
                    "taxonomic_classification",
                    "taxonomicClassification",
                ),
                "vernacular_names": self._normalize_vernacular_names(
                    self._first_value(
                        raw,
                        "vernacular_names",
                        "vernacularNames",
                        "common_names",
                        "commonNames",
                    ),
                    preferred_name=normalize_space(
                        self._first_value(
                            raw,
                            "common_name",
                            "commonName",
                            "preferred_common_name",
                            "preferredCommonName",
                        )
                    ),
                ),
                "conservation": self._normalize_conservation(
                    raw
                ),
                "distribution": self._list_value(
                    self._first_value(
                        raw,
                        "distribution",
                        "distributions",
                        "regions",
                        "states",
                    )
                ),
                "habitats": self._list_value(
                    self._first_value(
                        raw,
                        "habitats",
                        "habitat",
                    )
                ),
                "occurrence": {
                    "count": self._optional_int(
                        self._first_value(
                            raw,
                            "occurrence_count",
                            "occurrenceCount",
                            "record_count",
                            "recordCount",
                            "count",
                        )
                    ),
                    "spatially_valid_count": self._optional_int(
                        self._first_value(
                            raw,
                            "spatially_valid_count",
                            "spatiallyValidCount",
                        )
                    ),
                    "last_observed": normalize_space(
                        self._first_value(
                            raw,
                            "last_observed",
                            "lastObserved",
                            "last_occurrence_date",
                            "lastOccurrenceDate",
                        )
                    ),
                },
                "images": self._normalize_images(
                    self._first_value(
                        raw,
                        "images",
                        "image",
                        "media",
                    ),
                    raw,
                ),
                "descriptions": self._list_value(
                    self._first_value(
                        raw,
                        "descriptions",
                        "description",
                        "text",
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
                "data_resource": {
                    "uid": normalize_space(
                        self._first_value(
                            raw,
                            "data_resource_uid",
                            "dataResourceUid",
                            "data_resource_id",
                            "dataResourceId",
                        )
                    ),
                    "name": normalize_space(
                        self._first_value(
                            raw,
                            "data_resource_name",
                            "dataResourceName",
                            "data_provider",
                            "dataProvider",
                        )
                    ),
                },
                "nomenclature": {
                    "code": normalize_space(
                        self._first_value(
                            raw,
                            "nomenclatural_code",
                            "nomenclaturalCode",
                        )
                    ),
                    "status": normalize_space(
                        self._first_value(
                            raw,
                            "nomenclatural_status",
                            "nomenclaturalStatus",
                            "name_status",
                            "nameStatus",
                        )
                    ),
                },
                "is_exotic": self._optional_bool(
                    self._first_value(
                        raw,
                        "is_exotic",
                        "isExotic",
                        "exotic",
                    )
                ),
                "is_pest": self._optional_bool(
                    self._first_value(
                        raw,
                        "is_pest",
                        "isPest",
                        "pest",
                    )
                ),
                "is_native": self._optional_bool(
                    self._first_value(
                        raw,
                        "is_native",
                        "isNative",
                        "native",
                    )
                ),
                "references": self._list_value(
                    self._first_value(
                        raw,
                        "references",
                        "reference",
                        "bibliography",
                    )
                ),
                "attribution": self._normalize_attribution(
                    raw
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
        """Extract major lineage values from direct or nested classification."""

        classification = cls._first_mapping(
            raw,
            "classification",
            "taxonomic_classification",
            "taxonomicClassification",
        )

        lineage = {
            "domain": normalize_space(
                raw.get(
                    "domain"
                )
                or classification.get(
                    "domain"
                )
            ),
            "kingdom": normalize_space(
                raw.get(
                    "kingdom"
                )
                or classification.get(
                    "kingdom"
                )
            ),
            "phylum": normalize_space(
                raw.get(
                    "phylum"
                )
                or classification.get(
                    "phylum"
                )
            ),
            "division": normalize_space(
                raw.get(
                    "division"
                )
                or classification.get(
                    "division"
                )
            ),
            "class": normalize_space(
                raw.get(
                    "class"
                )
                or classification.get(
                    "class"
                )
            ),
            "order": normalize_space(
                raw.get(
                    "order"
                )
                or classification.get(
                    "order"
                )
            ),
            "family": normalize_space(
                raw.get(
                    "family"
                )
                or classification.get(
                    "family"
                )
            ),
            "genus": normalize_space(
                raw.get(
                    "genus"
                )
                or classification.get(
                    "genus"
                )
            ),
        }

        lineage_value = cls._first_value(
            raw,
            "lineage",
            "ancestors",
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

            rank = normalize_space(
                cls._first_value(
                    item,
                    "rank",
                    "taxon_rank",
                    "taxonRank",
                )
            ).casefold()

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
    def _normalize_vernacular_names(
        cls,
        value: Any,
        *,
        preferred_name: str,
    ) -> list[dict[str, Any]]:
        """Normalize vernacular names and preserve language metadata."""

        values = cls._list_value(
            value
        )

        if preferred_name:
            values.insert(
                0,
                {
                    "name": preferred_name,
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
                        "vernacular_name",
                        "vernacularName",
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

                raw = dict(
                    item
                )

            else:
                name = normalize_space(
                    item
                )
                language = ""
                preferred = None
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
                    "preferred": preferred,
                    "raw": raw,
                }
            )

        return result

    @classmethod
    def _normalize_conservation(
        cls,
        raw: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Normalize national, state, and international conservation values."""

        return {
            "status": normalize_space(
                cls._first_value(
                    raw,
                    "conservation_status",
                    "conservationStatus",
                    "threatened_status",
                    "threatenedStatus",
                )
            ),
            "national": cls._list_value(
                cls._first_value(
                    raw,
                    "national_conservation_status",
                    "nationalConservationStatus",
                    "national_status",
                    "nationalStatus",
                )
            ),
            "state": cls._list_value(
                cls._first_value(
                    raw,
                    "state_conservation_status",
                    "stateConservationStatus",
                    "state_status",
                    "stateStatus",
                )
            ),
            "international": cls._list_value(
                cls._first_value(
                    raw,
                    "international_conservation_status",
                    "internationalConservationStatus",
                    "international_status",
                    "internationalStatus",
                    "iucn_status",
                    "iucnStatus",
                )
            ),
            "sensitive": cls._optional_bool(
                cls._first_value(
                    raw,
                    "sensitive",
                    "is_sensitive",
                    "isSensitive",
                )
            ),
        }

    @classmethod
    def _normalize_images(
        cls,
        value: Any,
        raw: Mapping[str, Any],
    ) -> list[dict[str, Any]]:
        """Normalize image and media metadata."""

        values = cls._list_value(
            value
        )

        primary_url = normalize_space(
            cls._first_value(
                raw,
                "image_url",
                "imageUrl",
                "thumbnail_url",
                "thumbnailUrl",
            )
        )

        if primary_url:
            values.insert(
                0,
                {
                    "url": primary_url,
                    "primary": True,
                },
            )

        result: list[dict[str, Any]] = []

        for item in values:
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
                    "title": "",
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
        """Normalize external database identifiers."""

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
    def _normalize_attribution(
        cls,
        raw: Mapping[str, Any],
    ) -> dict[str, str]:
        """Normalize record-level provenance and rights metadata."""

        return {
            "data_provider": normalize_space(
                cls._first_value(
                    raw,
                    "data_provider",
                    "dataProvider",
                    "provider",
                )
            ),
            "data_resource": normalize_space(
                cls._first_value(
                    raw,
                    "data_resource",
                    "dataResource",
                    "resource",
                )
            ),
            "creator": normalize_space(
                cls._first_value(
                    raw,
                    "creator",
                    "author",
                    "contributor",
                )
            ),
            "rights_holder": normalize_space(
                cls._first_value(
                    raw,
                    "rights_holder",
                    "rightsHolder",
                    "owner",
                )
            ),
            "license": normalize_space(
                cls._first_value(
                    raw,
                    "license",
                    "rights",
                )
            ),
        }

    @staticmethod
    def _normalize_status(
        value: Any,
    ) -> str:
        """Normalize ALA taxonomic status terms."""

        status = normalize_space(
            value
        ).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "valid",
            "inferred accepted": "accepted",
            "synonym": "synonym",
            "inferred synonym": "synonym",
            "heterotypic synonym": "synonym",
            "homotypic synonym": "synonym",
            "misapplied": "misapplied",
            "excluded": "excluded",
            "doubtful": "unknown",
            "unresolved": "unknown",
        }

        return aliases.get(
            status,
            status or "unknown",
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
                f"Invalid Atlas of Living Australia cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "Atlas of Living Australia cursor must be non-negative."
            )

        return offset

    @staticmethod
    def _infer_rank(
        scientific_name: str,
    ) -> str:
        words = normalize_space(
            scientific_name
        ).split()

        if len(
            words
        ) == 2:
            return "species"

        if len(
            words
        ) >= 3:
            return "subspecies"

        return "unknown"

    @staticmethod
    def _first_mapping(
        record: Mapping[str, Any],
        *keys: str,
    ) -> dict[str, Any]:
        for key in keys:
            value = record.get(
                key
            )

            if isinstance(
                value,
                Mapping,
            ):
                return dict(
                    value
                )

        return {}

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
