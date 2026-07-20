#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/fishbase.py

FishBase provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It does not assume access to an undocumented,
unlicensed, or unstable public API.

Each source record is normalized into the shared Taxon contract while the
complete FishBase object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "fishbase",
        "path": "static/data/providers/fishbase/species.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "FishBase",
        "source_url": "https://www.fishbase.se/"
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
    """File-backed FishBase provider."""

    PROVIDER_NAME = "fishbase"

    DEFAULT_SOURCE_NAME = "FishBase"
    DEFAULT_SOURCE_URL = "https://www.fishbase.se/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable FishBase JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"FishBase export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"FishBase path is not a file: {source_path}"
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
        """Resolve the configured FishBase JSONL source path."""

        configured = normalize_space(
            self.definition.get(
                "path"
            )
        )

        if not configured:
            raise ProviderError(
                "FishBase provider requires a path."
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
        """Normalize one FishBase species record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "spec_code",
                "specCode",
                "species_code",
                "speciesCode",
                "taxon_id",
                "taxonId",
                "id",
            )
        )

        genus = normalize_space(
            self._first_value(
                raw,
                "genus",
                "genus_name",
                "genusName",
            )
        )

        species_epithet = normalize_space(
            self._first_value(
                raw,
                "species",
                "species_epithet",
                "speciesEpithet",
            )
        )

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "name",
            )
        )

        if (
            not scientific_name
            and genus
            and species_epithet
        ):
            scientific_name = (
                f"{genus} {species_epithet}"
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

        rank = normalize_space(
            self._first_value(
                raw,
                "rank",
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
                "validity",
            )
        )

        accepted_provider_id = normalize_space(
            self._first_value(
                raw,
                "accepted_spec_code",
                "acceptedSpecCode",
                "accepted_species_code",
                "acceptedSpeciesCode",
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
                "species_url",
                "speciesUrl",
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
                + "/summary/"
                + canonical_name.replace(
                    " ",
                    "-",
                )
                + ".html"
            )

        lineage = self._extract_lineage(
            raw,
            genus=genus,
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
                    "authority",
                    "species_author",
                    "speciesAuthor",
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
                "Actinopterygii",
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
                genus,
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
                "programme": "fishbase",
                "reference_only": True,
                "spec_code": provider_id,
                "accepted_spec_code": accepted_provider_id,
                "lineage": lineage,
                "parent": {
                    "id": normalize_space(
                        self._first_value(
                            raw,
                            "parent_id",
                            "parentId",
                            "parent_taxon_id",
                            "parentTaxonId",
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
                        )
                    ),
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
                    "brackish": self._optional_bool(
                        self._first_value(
                            raw,
                            "brackish",
                            "is_brackish",
                            "isBrackish",
                        )
                    ),
                    "demersal": self._optional_bool(
                        self._first_value(
                            raw,
                            "demersal",
                            "is_demersal",
                            "isDemersal",
                        )
                    ),
                    "pelagic": self._optional_bool(
                        self._first_value(
                            raw,
                            "pelagic",
                            "is_pelagic",
                            "isPelagic",
                        )
                    ),
                    "reef_associated": self._optional_bool(
                        self._first_value(
                            raw,
                            "reef_associated",
                            "reefAssociated",
                        )
                    ),
                },
                "distribution": self._list_value(
                    self._first_value(
                        raw,
                        "distribution",
                        "distributions",
                        "countries",
                        "country",
                        "range",
                    )
                ),
                "habitats": self._list_value(
                    self._first_value(
                        raw,
                        "habitats",
                        "habitat",
                    )
                ),
                "ecology": {
                    "trophic_level": self._optional_float(
                        self._first_value(
                            raw,
                            "trophic_level",
                            "trophicLevel",
                        )
                    ),
                    "diet": self._list_value(
                        self._first_value(
                            raw,
                            "diet",
                            "food_items",
                            "foodItems",
                        )
                    ),
                    "depth_min_m": self._optional_float(
                        self._first_value(
                            raw,
                            "depth_min",
                            "depthMin",
                            "depth_min_m",
                            "depthMinM",
                        )
                    ),
                    "depth_max_m": self._optional_float(
                        self._first_value(
                            raw,
                            "depth_max",
                            "depthMax",
                            "depth_max_m",
                            "depthMaxM",
                        )
                    ),
                    "temperature_min_c": self._optional_float(
                        self._first_value(
                            raw,
                            "temperature_min",
                            "temperatureMin",
                            "temp_min",
                            "tempMin",
                        )
                    ),
                    "temperature_max_c": self._optional_float(
                        self._first_value(
                            raw,
                            "temperature_max",
                            "temperatureMax",
                            "temp_max",
                            "tempMax",
                        )
                    ),
                },
                "morphology": {
                    "length_max_cm": self._optional_float(
                        self._first_value(
                            raw,
                            "length_max",
                            "lengthMax",
                            "length",
                        )
                    ),
                    "length_type": normalize_space(
                        self._first_value(
                            raw,
                            "length_type",
                            "lengthType",
                        )
                    ),
                    "weight_max_kg": self._optional_float(
                        self._first_value(
                            raw,
                            "weight_max",
                            "weightMax",
                            "weight",
                        )
                    ),
                    "body_shape": normalize_space(
                        self._first_value(
                            raw,
                            "body_shape",
                            "bodyShape",
                        )
                    ),
                    "coloration": normalize_space(
                        self._first_value(
                            raw,
                            "coloration",
                            "colouration",
                        )
                    ),
                },
                "life_history": {
                    "maturity_length_cm": self._optional_float(
                        self._first_value(
                            raw,
                            "maturity_length",
                            "maturityLength",
                        )
                    ),
                    "maturity_age_years": self._optional_float(
                        self._first_value(
                            raw,
                            "maturity_age",
                            "maturityAge",
                        )
                    ),
                    "generation_time_years": self._optional_float(
                        self._first_value(
                            raw,
                            "generation_time",
                            "generationTime",
                        )
                    ),
                    "longevity_years": self._optional_float(
                        self._first_value(
                            raw,
                            "longevity",
                            "max_age",
                            "maxAge",
                        )
                    ),
                    "reproductive_mode": normalize_space(
                        self._first_value(
                            raw,
                            "reproductive_mode",
                            "reproductiveMode",
                        )
                    ),
                    "spawning": self._list_value(
                        self._first_value(
                            raw,
                            "spawning",
                            "spawning_period",
                            "spawningPeriod",
                        )
                    ),
                },
                "fisheries": {
                    "importance": normalize_space(
                        self._first_value(
                            raw,
                            "fishery_importance",
                            "fisheryImportance",
                            "fisheries_importance",
                            "fisheriesImportance",
                        )
                    ),
                    "aquaculture": self._optional_bool(
                        self._first_value(
                            raw,
                            "aquaculture",
                            "used_in_aquaculture",
                            "usedInAquaculture",
                        )
                    ),
                    "game_fish": self._optional_bool(
                        self._first_value(
                            raw,
                            "game_fish",
                            "gameFish",
                        )
                    ),
                    "bait": self._optional_bool(
                        self._first_value(
                            raw,
                            "bait",
                            "used_as_bait",
                            "usedAsBait",
                        )
                    ),
                    "human_consumption": self._optional_bool(
                        self._first_value(
                            raw,
                            "human_consumption",
                            "humanConsumption",
                        )
                    ),
                    "vulnerability": self._optional_float(
                        self._first_value(
                            raw,
                            "vulnerability",
                            "vulnerability_score",
                            "vulnerabilityScore",
                        )
                    ),
                    "price_category": normalize_space(
                        self._first_value(
                            raw,
                            "price_category",
                            "priceCategory",
                        )
                    ),
                },
                "conservation": {
                    "iucn_status": normalize_space(
                        self._first_value(
                            raw,
                            "iucn_status",
                            "iucnStatus",
                            "conservation_status",
                            "conservationStatus",
                        )
                    ),
                    "cites": normalize_space(
                        self._first_value(
                            raw,
                            "cites",
                            "cites_status",
                            "citesStatus",
                        )
                    ),
                    "threatened": self._optional_bool(
                        self._first_value(
                            raw,
                            "threatened",
                            "is_threatened",
                            "isThreatened",
                        )
                    ),
                    "dangerous": self._optional_bool(
                        self._first_value(
                            raw,
                            "dangerous",
                            "is_dangerous",
                            "isDangerous",
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
                "references": self._normalize_references(
                    self._first_value(
                        raw,
                        "references",
                        "reference",
                        "bibliography",
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
    def _extract_lineage(
        cls,
        raw: Mapping[str, Any],
        *,
        genus: str,
    ) -> dict[str, str]:
        """Extract fish lineage from direct fields or hierarchy data."""

        lineage = {
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
            ) or "Actinopterygii",
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
            "subfamily": normalize_space(
                cls._first_value(
                    raw,
                    "subfamily",
                    "subfamily_name",
                    "subfamilyName",
                )
            ),
            "genus": genus
            or normalize_space(
                raw.get(
                    "genus"
                )
            ),
        }

        lineage_value = cls._first_value(
            raw,
            "lineage",
            "classification",
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
        """Extract and deduplicate scientific-name synonyms."""

        values = cls._list_value(
            cls._first_value(
                raw,
                "synonyms",
                "synonym",
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
    def _normalize_common_names(
        cls,
        value: Any,
        *,
        preferred: str,
    ) -> list[dict[str, Any]]:
        """Normalize common names with language and locality metadata."""

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
                        "language_code",
                        "languageCode",
                    )
                )

                locality = normalize_space(
                    cls._first_value(
                        item,
                        "locality",
                        "country",
                        "region",
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
                locality = ""
                preferred_value = None
                raw = item

            key = (
                name.casefold(),
                language.casefold(),
                locality.casefold(),
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
                    "locality": locality,
                    "preferred": preferred_value,
                    "raw": raw,
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
                        "caption": normalize_space(
                            cls._first_value(
                                item,
                                "caption",
                                "title",
                                "description",
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
                    "caption": "",
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
    def _normalize_references(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize FishBase references and citations."""

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
                        "reference_id": normalize_space(
                            cls._first_value(
                                item,
                                "reference_id",
                                "referenceId",
                                "ref_no",
                                "refNo",
                                "id",
                            )
                        ),
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
                            "reference_id": "",
                            "citation": citation,
                            "url": "",
                        }
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

    @staticmethod
    def _normalize_status(
        value: Any,
    ) -> str:
        """Normalize FishBase taxonomic status terms."""

        status = normalize_space(
            value
        ).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "valid",
            "synonym": "synonym",
            "unaccepted": "synonym",
            "questionable": "unknown",
            "doubtful": "unknown",
            "misapplied": "misapplied",
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
                f"Invalid FishBase cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "FishBase cursor must be non-negative."
            )

        return offset

    @staticmethod
    def _infer_rank(
        scientific_name: str,
    ) -> str:
        words = normalize_space(
            scientific_name
        ).split()

        if len(words) == 2:
            return "species"

        if len(words) >= 3:
            return "subspecies"

        return "unknown"

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
