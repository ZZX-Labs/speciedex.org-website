#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/global_names.py

Global Names provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It does not assume access to an undocumented or
unstable public API.

The provider is intended to ingest outputs from Global Names services and
related bulk workflows, including parsed scientific names, canonical forms,
authorship, nomenclatural annotations, verification matches, data-source
metadata, and complete raw records.

Required provider configuration:

    {
        "name": "global_names",
        "path": "static/data/providers/global-names/names.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "Global Names",
        "source_url": "https://globalnames.org/"
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
    """File-backed Global Names provider."""

    PROVIDER_NAME = "global_names"

    DEFAULT_SOURCE_NAME = "Global Names"
    DEFAULT_SOURCE_URL = "https://globalnames.org/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable Global Names JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"Global Names export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"Global Names path is not a file: {source_path}"
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
                "Global Names provider requires a path."
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
        """Normalize one Global Names parse or verification record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "id",
                "name_id",
                "nameId",
                "nameID",
                "record_id",
                "recordId",
                "uuid",
                "verbatim_id",
                "verbatimId",
            )
        )

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "verbatim",
                "name",
                "normalized",
                "normalized_name",
                "normalizedName",
            )
        )

        if not provider_id or not scientific_name:
            return None

        canonical_name = normalize_space(
            self._first_value(
                raw,
                "canonical_name",
                "canonicalName",
                "canonical",
                "canonical_simple",
                "canonicalSimple",
                "normalized_name",
                "normalizedName",
            )
        ) or scientific_name

        rank = normalize_space(
            self._first_value(
                raw,
                "rank",
                "taxon_rank",
                "taxonRank",
                "parsed_rank",
                "parsedRank",
            )
        ).casefold() or self._infer_rank(
            canonical_name
        )

        verification = self._first_mapping(
            raw,
            "verification",
            "verified_match",
            "verifiedMatch",
            "best_match",
            "bestMatch",
            "match",
        )

        accepted_provider_id = normalize_space(
            self._first_value(
                verification,
                "accepted_id",
                "acceptedId",
                "taxon_id",
                "taxonId",
                "record_id",
                "recordId",
                "id",
            )
            or self._first_value(
                raw,
                "accepted_id",
                "acceptedId",
                "accepted_taxon_id",
                "acceptedTaxonId",
            )
        )

        if accepted_provider_id == provider_id:
            accepted_provider_id = ""

        status = self._normalize_status(
            self._first_value(
                verification,
                "status",
                "taxonomic_status",
                "taxonomicStatus",
                "match_type",
                "matchType",
            )
            or self._first_value(
                raw,
                "status",
                "taxonomic_status",
                "taxonomicStatus",
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
            or self._first_value(
                verification,
                "url",
                "source_url",
                "sourceUrl",
            )
        ) or normalize_space(
            self.definition.get(
                "source_url",
                self.DEFAULT_SOURCE_URL,
            )
        )

        parsed = self._first_mapping(
            raw,
            "parsed",
            "parse",
            "parsed_name",
            "parsedName",
        )

        authorship = normalize_space(
            self._first_value(
                parsed,
                "authorship",
                "author",
                "authors",
            )
            or self._first_value(
                raw,
                "authorship",
                "scientific_name_authorship",
                "scientificNameAuthorship",
                "author",
            )
        )

        lineage = self._extract_lineage(
            raw,
            verification,
        )

        synonyms = self._extract_synonyms(
            raw,
            verification=verification,
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
            authorship=authorship,
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
                "programme": "global_names",
                "reference_only": True,
                "name_id": provider_id,
                "verbatim": normalize_space(
                    self._first_value(
                        raw,
                        "verbatim",
                        "scientific_name",
                        "scientificName",
                        "name",
                    )
                ),
                "normalized_name": normalize_space(
                    self._first_value(
                        raw,
                        "normalized",
                        "normalized_name",
                        "normalizedName",
                    )
                ),
                "canonical": {
                    "full": normalize_space(
                        self._first_value(
                            raw,
                            "canonical",
                            "canonical_name",
                            "canonicalName",
                        )
                    ),
                    "simple": normalize_space(
                        self._first_value(
                            raw,
                            "canonical_simple",
                            "canonicalSimple",
                        )
                    ),
                    "stemmed": normalize_space(
                        self._first_value(
                            raw,
                            "canonical_stemmed",
                            "canonicalStemmed",
                        )
                    ),
                },
                "parsed": self._normalize_parsed_name(
                    parsed,
                    raw,
                ),
                "quality": {
                    "parse_quality": self._optional_int(
                        self._first_value(
                            raw,
                            "parse_quality",
                            "parseQuality",
                            "quality",
                        )
                    ),
                    "cardinality": self._optional_int(
                        self._first_value(
                            raw,
                            "cardinality",
                        )
                    ),
                    "surrogate": self._optional_bool(
                        self._first_value(
                            raw,
                            "surrogate",
                            "is_surrogate",
                            "isSurrogate",
                        )
                    ),
                    "virus": self._optional_bool(
                        self._first_value(
                            raw,
                            "virus",
                            "is_virus",
                            "isVirus",
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
                    "cultivar": self._optional_bool(
                        self._first_value(
                            raw,
                            "cultivar",
                            "is_cultivar",
                            "isCultivar",
                        )
                    ),
                    "bacteria": self._optional_bool(
                        self._first_value(
                            raw,
                            "bacteria",
                            "is_bacteria",
                            "isBacteria",
                        )
                    ),
                },
                "verification": self._normalize_verification(
                    verification
                ),
                "matches": self._normalize_matches(
                    self._first_value(
                        raw,
                        "matches",
                        "results",
                        "verification_results",
                        "verificationResults",
                    )
                ),
                "data_sources": self._normalize_data_sources(
                    self._first_value(
                        raw,
                        "data_sources",
                        "dataSources",
                        "sources",
                    )
                ),
                "lineage": lineage,
                "nomenclature": {
                    "code": normalize_space(
                        self._first_value(
                            parsed,
                            "code",
                            "nomenclatural_code",
                            "nomenclaturalCode",
                        )
                        or self._first_value(
                            raw,
                            "nomenclatural_code",
                            "nomenclaturalCode",
                        )
                    ),
                    "annotation": normalize_space(
                        self._first_value(
                            parsed,
                            "annotation",
                            "nomenclatural_note",
                            "nomenclaturalNote",
                        )
                        or self._first_value(
                            raw,
                            "annotation",
                            "nomenclatural_note",
                            "nomenclaturalNote",
                        )
                    ),
                },
                "references": self._list_value(
                    self._first_value(
                        raw,
                        "references",
                        "reference",
                    )
                ),
                "bulk_source": source_path.as_posix(),
                "raw": raw,
            },
        )

    @classmethod
    def _normalize_parsed_name(
        cls,
        parsed: Mapping[str, Any],
        raw: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Normalize parsed-name components without losing provider fields."""

        result = dict(
            parsed
        )

        result.update(
            {
                "genus": normalize_space(
                    cls._first_value(
                        parsed,
                        "genus",
                        "genus_name",
                        "genusName",
                    )
                    or cls._first_value(
                        raw,
                        "genus",
                    )
                ),
                "specific_epithet": normalize_space(
                    cls._first_value(
                        parsed,
                        "specific_epithet",
                        "specificEpithet",
                        "species",
                    )
                ),
                "infraspecific_epithet": normalize_space(
                    cls._first_value(
                        parsed,
                        "infraspecific_epithet",
                        "infraspecificEpithet",
                        "subspecies",
                    )
                ),
                "uninomial": normalize_space(
                    cls._first_value(
                        parsed,
                        "uninomial",
                    )
                ),
                "cultivar": normalize_space(
                    cls._first_value(
                        parsed,
                        "cultivar",
                        "cultivar_epithet",
                        "cultivarEpithet",
                    )
                ),
                "authorship": normalize_space(
                    cls._first_value(
                        parsed,
                        "authorship",
                        "author",
                    )
                ),
                "year": normalize_space(
                    cls._first_value(
                        parsed,
                        "year",
                    )
                ),
                "rank": normalize_space(
                    cls._first_value(
                        parsed,
                        "rank",
                    )
                ).casefold(),
            }
        )

        return result

    @classmethod
    def _normalize_verification(
        cls,
        value: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Normalize best-match verification metadata."""

        result = dict(
            value
        )

        result.update(
            {
                "id": normalize_space(
                    cls._first_value(
                        value,
                        "id",
                        "record_id",
                        "recordId",
                        "taxon_id",
                        "taxonId",
                    )
                ),
                "scientific_name": normalize_space(
                    cls._first_value(
                        value,
                        "scientific_name",
                        "scientificName",
                        "name",
                    )
                ),
                "canonical_name": normalize_space(
                    cls._first_value(
                        value,
                        "canonical_name",
                        "canonicalName",
                        "canonical",
                    )
                ),
                "rank": normalize_space(
                    cls._first_value(
                        value,
                        "rank",
                        "taxon_rank",
                        "taxonRank",
                    )
                ).casefold(),
                "status": normalize_space(
                    cls._first_value(
                        value,
                        "status",
                        "taxonomic_status",
                        "taxonomicStatus",
                    )
                ).casefold(),
                "score": cls._optional_float(
                    cls._first_value(
                        value,
                        "score",
                        "match_score",
                        "matchScore",
                    )
                ),
                "data_source_id": normalize_space(
                    cls._first_value(
                        value,
                        "data_source_id",
                        "dataSourceId",
                        "source_id",
                        "sourceId",
                    )
                ),
                "data_source_title": normalize_space(
                    cls._first_value(
                        value,
                        "data_source_title",
                        "dataSourceTitle",
                        "source_title",
                        "sourceTitle",
                    )
                ),
            }
        )

        return result

    @classmethod
    def _normalize_matches(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize verification candidate matches."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(
            value
        ):
            if not isinstance(
                item,
                Mapping,
            ):
                continue

            result.append(
                cls._normalize_verification(
                    item
                )
            )

        return result

    @classmethod
    def _normalize_data_sources(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize Global Names data-source metadata."""

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
                        "id": normalize_space(
                            cls._first_value(
                                item,
                                "id",
                                "data_source_id",
                                "dataSourceId",
                            )
                        ),
                        "title": normalize_space(
                            cls._first_value(
                                item,
                                "title",
                                "name",
                                "data_source_title",
                                "dataSourceTitle",
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
                title = normalize_space(
                    item
                )

                if title:
                    result.append(
                        {
                            "id": "",
                            "title": title,
                            "url": "",
                        }
                    )

        return result

    @classmethod
    def _extract_lineage(
        cls,
        raw: Mapping[str, Any],
        verification: Mapping[str, Any],
    ) -> dict[str, str]:
        """Extract lineage from direct fields, verification, or hierarchy lists."""

        lineage = {
            "kingdom": normalize_space(
                raw.get(
                    "kingdom"
                )
                or verification.get(
                    "kingdom"
                )
            ),
            "phylum": normalize_space(
                raw.get(
                    "phylum"
                )
                or verification.get(
                    "phylum"
                )
            ),
            "division": normalize_space(
                raw.get(
                    "division"
                )
                or verification.get(
                    "division"
                )
            ),
            "class": normalize_space(
                raw.get(
                    "class"
                )
                or verification.get(
                    "class"
                )
            ),
            "order": normalize_space(
                raw.get(
                    "order"
                )
                or verification.get(
                    "order"
                )
            ),
            "family": normalize_space(
                raw.get(
                    "family"
                )
                or verification.get(
                    "family"
                )
            ),
            "genus": normalize_space(
                raw.get(
                    "genus"
                )
                or verification.get(
                    "genus"
                )
            ),
        }

        hierarchy = cls._first_value(
            raw,
            "lineage",
            "classification",
            "higher_taxa",
            "higherTaxa",
        ) or cls._first_value(
            verification,
            "lineage",
            "classification",
            "higher_taxa",
            "higherTaxa",
        )

        for item in cls._list_value(
            hierarchy
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
        verification: Mapping[str, Any],
        scientific_name: str,
        canonical_name: str,
    ) -> list[str]:
        """Extract and deduplicate synonym-like names."""

        values = cls._list_value(
            cls._first_value(
                raw,
                "synonyms",
                "synonym",
                "alternative_names",
                "alternativeNames",
            )
        )

        verified_name = normalize_space(
            cls._first_value(
                verification,
                "scientific_name",
                "scientificName",
                "name",
            )
        )

        if verified_name:
            values.append(
                verified_name
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
                        "canonical_name",
                        "canonicalName",
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
    def _normalize_status(
        value: Any,
    ) -> str:
        """Normalize verification and taxonomic status terms."""

        status = normalize_space(
            value
        ).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "valid",
            "exact": "accepted",
            "fuzzy": "reference",
            "partial": "reference",
            "synonym": "synonym",
            "unaccepted": "synonym",
            "ambiguous": "unknown",
            "unresolved": "unknown",
            "no match": "unknown",
            "reference": "reference",
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
                f"Invalid Global Names cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "Global Names cursor must be non-negative."
            )

        return offset

    @staticmethod
    def _infer_rank(
        scientific_name: str,
    ) -> str:
        words = normalize_space(
            scientific_name
        ).split()

        if len(words) == 1:
            return "unranked"

        if len(words) == 2:
            return "species"

        if len(words) >= 3:
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
