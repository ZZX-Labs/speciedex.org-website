#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/ebird.py

eBird / Clements Checklist provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It does not assume access to an undocumented,
unlicensed, or unstable public API.

Each source record is normalized into the shared Taxon contract while the
complete eBird/Clements object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "ebird",
        "path": "static/data/providers/ebird/taxa.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "eBird / Clements Checklist",
        "source_url": "https://ebird.org/science/use-ebird-data/the-ebird-taxonomy"
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
    """File-backed eBird / Clements Checklist provider."""

    PROVIDER_NAME = "ebird"

    DEFAULT_SOURCE_NAME = "eBird / Clements Checklist"
    DEFAULT_SOURCE_URL = (
        "https://ebird.org/science/use-ebird-data/the-ebird-taxonomy"
    )

    def fetch(self) -> Batch:
        """Read and normalize one resumable eBird JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"eBird/Clements export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"eBird/Clements path is not a file: {source_path}"
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
        """Resolve the configured eBird JSONL source path."""

        configured = normalize_space(
            self.definition.get(
                "path"
            )
        )

        if not configured:
            raise ProviderError(
                "eBird provider requires a path."
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
        """Normalize one eBird/Clements taxonomy record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "species_code",
                "speciesCode",
                "taxon_code",
                "taxonCode",
                "code",
                "id",
            )
        )

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "sci_name",
                "sciName",
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
                "sci_name",
                "sciName",
            )
        ) or scientific_name

        category = self._normalize_category(
            self._first_value(
                raw,
                "category",
                "taxon_category",
                "taxonCategory",
            )
        )

        rank = self._rank_from_category(
            category,
            canonical_name,
        )

        status = self._normalize_status(
            raw,
            category=category,
        )

        accepted_provider_id = normalize_space(
            self._first_value(
                raw,
                "accepted_species_code",
                "acceptedSpeciesCode",
                "accepted_code",
                "acceptedCode",
                "parent_species_code",
                "parentSpeciesCode",
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
                "taxon_url",
                "taxonUrl",
            )
        )

        if not source_url:
            source_url = (
                "https://ebird.org/species/"
                + provider_id
            )

        lineage = self._extract_lineage(
            raw,
            scientific_name=scientific_name,
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
            kingdom=lineage.get(
                "kingdom",
                "Animalia",
            ),
            phylum=lineage.get(
                "phylum",
                "Chordata",
            ),
            class_name=lineage.get(
                "class",
                "Aves",
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
                    "checklist_version",
                    "checklistVersion",
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
                "programme": "ebird_clements",
                "reference_only": True,
                "species_code": provider_id,
                "taxon_order": self._optional_float(
                    self._first_value(
                        raw,
                        "taxon_order",
                        "taxonOrder",
                        "sort_order",
                        "sortOrder",
                    )
                ),
                "category": category,
                "common_name": normalize_space(
                    self._first_value(
                        raw,
                        "common_name",
                        "commonName",
                        "com_name",
                        "comName",
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
                            "common_name",
                            "commonName",
                            "com_name",
                            "comName",
                        )
                    ),
                ),
                "lineage": lineage,
                "grouping": {
                    "parent_species_code": normalize_space(
                        self._first_value(
                            raw,
                            "parent_species_code",
                            "parentSpeciesCode",
                        )
                    ),
                    "slash_group": normalize_space(
                        self._first_value(
                            raw,
                            "slash_group",
                            "slashGroup",
                        )
                    ),
                    "spuh_group": normalize_space(
                        self._first_value(
                            raw,
                            "spuh_group",
                            "spuhGroup",
                        )
                    ),
                    "hybrid_group": normalize_space(
                        self._first_value(
                            raw,
                            "hybrid_group",
                            "hybridGroup",
                        )
                    ),
                },
                "checklist": {
                    "version": normalize_space(
                        self._first_value(
                            raw,
                            "checklist_version",
                            "checklistVersion",
                            "version",
                        )
                    ),
                    "edition": normalize_space(
                        self._first_value(
                            raw,
                            "edition",
                            "checklist_edition",
                            "checklistEdition",
                        )
                    ),
                    "published": normalize_space(
                        self._first_value(
                            raw,
                            "published",
                            "publication_date",
                            "publicationDate",
                        )
                    ),
                },
                "region": {
                    "code": normalize_space(
                        self._first_value(
                            raw,
                            "region_code",
                            "regionCode",
                        )
                    ),
                    "name": normalize_space(
                        self._first_value(
                            raw,
                            "region_name",
                            "regionName",
                            "region",
                        )
                    ),
                },
                "extinct": self._optional_bool(
                    self._first_value(
                        raw,
                        "extinct",
                        "is_extinct",
                        "isExtinct",
                    )
                ),
                "introduced": self._optional_bool(
                    self._first_value(
                        raw,
                        "introduced",
                        "is_introduced",
                        "isIntroduced",
                    )
                ),
                "domestic": self._optional_bool(
                    self._first_value(
                        raw,
                        "domestic",
                        "is_domestic",
                        "isDomestic",
                    )
                ),
                "provisional": self._optional_bool(
                    self._first_value(
                        raw,
                        "provisional",
                        "is_provisional",
                        "isProvisional",
                    )
                ),
                "taxonomic_notes": self._list_value(
                    self._first_value(
                        raw,
                        "taxonomic_notes",
                        "taxonomicNotes",
                        "notes",
                        "remarks",
                    )
                ),
                "distribution": self._list_value(
                    self._first_value(
                        raw,
                        "distribution",
                        "regions",
                        "range",
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
                "bulk_source": source_path.as_posix(),
                "raw": raw,
            },
        )

    @classmethod
    def _extract_lineage(
        cls,
        raw: Mapping[str, Any],
        *,
        scientific_name: str,
    ) -> dict[str, str]:
        """Extract avian lineage information."""

        genus = normalize_space(
            raw.get(
                "genus"
            )
        )

        if not genus:
            words = scientific_name.split()

            if words:
                genus = words[0]

        return {
            "kingdom": normalize_space(
                raw.get(
                    "kingdom"
                )
            ) or "Animalia",
            "phylum": normalize_space(
                raw.get(
                    "phylum"
                )
            ) or "Chordata",
            "class": normalize_space(
                raw.get(
                    "class"
                )
            ) or "Aves",
            "order": normalize_space(
                cls._first_value(
                    raw,
                    "order",
                    "order_name",
                    "orderName",
                )
            ),
            "family": normalize_space(
                cls._first_value(
                    raw,
                    "family",
                    "family_name",
                    "familyName",
                )
            ),
            "genus": genus,
        }

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
                "scientific_name_synonyms",
                "scientificNameSynonyms",
                "former_names",
                "formerNames",
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
    def _normalize_common_names(
        cls,
        value: Any,
        *,
        preferred: str,
    ) -> list[dict[str, Any]]:
        """Normalize common names with language and regional metadata."""

        values = cls._list_value(
            value
        )

        if preferred:
            values.insert(
                0,
                {
                    "name": preferred,
                    "language": "en",
                    "preferred": True,
                },
            )

        result: list[dict[str, Any]] = []
        seen: set[tuple[str, str, str]] = set()

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

                region = normalize_space(
                    cls._first_value(
                        item,
                        "region",
                        "region_code",
                        "regionCode",
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
                region = ""
                preferred_value = None
                raw = item

            key = (
                name.casefold(),
                language.casefold(),
                region.casefold(),
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
                    "region": region,
                    "preferred": preferred_value,
                    "raw": raw,
                }
            )

        return result

    @classmethod
    def _normalize_identifiers(
        cls,
        value: Any,
    ) -> list[dict[str, str]]:
        """Normalize external taxonomic identifiers."""

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
        """Normalize checklist references and citations."""

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
                            "url": "",
                        }
                    )

        return result

    @staticmethod
    def _normalize_category(
        value: Any,
    ) -> str:
        """Normalize eBird taxonomy category values."""

        category = normalize_space(
            value
        ).casefold().replace(
            "_",
            " ",
        )

        aliases = {
            "species": "species",
            "issf": "subspecies",
            "subspecies": "subspecies",
            "slash": "slash",
            "spuh": "spuh",
            "hybrid": "hybrid",
            "intergrade": "intergrade",
            "form": "form",
            "domestic": "domestic",
        }

        return aliases.get(
            category,
            category or "unknown",
        )

    @staticmethod
    def _rank_from_category(
        category: str,
        scientific_name: str,
    ) -> str:
        mapping = {
            "species": "species",
            "subspecies": "subspecies",
            "form": "form",
            "hybrid": "hybrid",
            "intergrade": "hybrid",
            "slash": "unranked",
            "spuh": "unranked",
            "domestic": "form",
        }

        if category in mapping:
            return mapping[
                category
            ]

        words = normalize_space(
            scientific_name
        ).split()

        if len(words) == 2:
            return "species"

        if len(words) >= 3:
            return "subspecies"

        return "unranked"

    @staticmethod
    def _normalize_status(
        raw: Mapping[str, Any],
        *,
        category: str,
    ) -> str:
        """Normalize eBird record status."""

        if Provider._optional_bool(
            Provider._first_value(
                raw,
                "extinct",
                "is_extinct",
                "isExtinct",
            )
        ):
            return "extinct"

        if category in {
            "slash",
            "spuh",
            "hybrid",
            "intergrade",
            "domestic",
        }:
            return "reference"

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
            "provisional": "provisionally accepted",
            "inactive": "inactive",
            "deprecated": "inactive",
            "reference": "reference",
        }

        return aliases.get(
            status,
            status or "accepted",
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
                f"Invalid eBird cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "eBird cursor must be non-negative."
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
