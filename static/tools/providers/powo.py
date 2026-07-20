#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/powo.py

Plants of the World Online (POWO) provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It does not assume access to an undocumented,
unlicensed, or unstable public API.

Each source record is normalized into the shared Taxon contract while the
complete POWO object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "powo",
        "path": "static/data/providers/powo/taxa.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "Plants of the World Online",
        "source_url": "https://powo.science.kew.org/"
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
    """File-backed Plants of the World Online provider."""

    PROVIDER_NAME = "powo"

    DEFAULT_SOURCE_NAME = "Plants of the World Online"
    DEFAULT_SOURCE_URL = "https://powo.science.kew.org/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable POWO JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"POWO export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"POWO path is not a file: {source_path}"
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
        """Resolve the configured POWO JSONL source path."""

        configured = normalize_space(
            self.definition.get(
                "path"
            )
        )

        if not configured:
            raise ProviderError(
                "POWO provider requires a path."
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
        """Normalize one POWO plant taxon record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "fq_id",
                "fqId",
                "taxon_id",
                "taxonId",
                "taxonID",
                "ipni_id",
                "ipniId",
                "lsid",
                "id",
            )
        )

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "full_name",
                "fullName",
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
                "name",
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
            rank = self._infer_rank(
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
                "accepted_name_id",
                "acceptedNameId",
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
                "record_url",
                "recordUrl",
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
                + "/taxon/"
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
                    "authority",
                    "scientific_name_authorship",
                    "scientificNameAuthorship",
                )
            ),
            kingdom=lineage.get(
                "kingdom",
                "Plantae",
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
                "programme": "plants_of_the_world_online",
                "reference_only": True,
                "powo_id": provider_id,
                "ipni_id": normalize_space(
                    self._first_value(
                        raw,
                        "ipni_id",
                        "ipniId",
                    )
                ),
                "lsid": normalize_space(
                    self._first_value(
                        raw,
                        "lsid",
                    )
                ),
                "accepted_name_id": accepted_provider_id,
                "lineage": lineage,
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
                "nomenclature": {
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
                    "original_name": normalize_space(
                        self._first_value(
                            raw,
                            "original_name",
                            "originalName",
                        )
                    ),
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
                    "published_in": normalize_space(
                        self._first_value(
                            raw,
                            "published_in",
                            "publishedIn",
                            "publication",
                        )
                    ),
                },
                "distribution": {
                    "native": self._normalize_regions(
                        self._first_value(
                            raw,
                            "native_distribution",
                            "nativeDistribution",
                            "native_regions",
                            "nativeRegions",
                            "native",
                        )
                    ),
                    "introduced": self._normalize_regions(
                        self._first_value(
                            raw,
                            "introduced_distribution",
                            "introducedDistribution",
                            "introduced_regions",
                            "introducedRegions",
                            "introduced",
                        )
                    ),
                    "extinct": self._normalize_regions(
                        self._first_value(
                            raw,
                            "extinct_distribution",
                            "extinctDistribution",
                            "extinct_regions",
                            "extinctRegions",
                        )
                    ),
                    "doubtful": self._normalize_regions(
                        self._first_value(
                            raw,
                            "doubtful_distribution",
                            "doubtfulDistribution",
                            "doubtful_regions",
                            "doubtfulRegions",
                        )
                    ),
                    "summary": normalize_space(
                        self._first_value(
                            raw,
                            "distribution_summary",
                            "distributionSummary",
                            "distribution",
                        )
                    ),
                },
                "ecology": {
                    "life_form": self._list_value(
                        self._first_value(
                            raw,
                            "life_form",
                            "lifeForm",
                            "growth_form",
                            "growthForm",
                        )
                    ),
                    "habitat": self._list_value(
                        self._first_value(
                            raw,
                            "habitat",
                            "habitats",
                        )
                    ),
                    "climate": self._list_value(
                        self._first_value(
                            raw,
                            "climate",
                            "climatic_zones",
                            "climaticZones",
                        )
                    ),
                    "biome": self._list_value(
                        self._first_value(
                            raw,
                            "biome",
                            "biomes",
                        )
                    ),
                    "elevation_min_m": self._optional_float(
                        self._first_value(
                            raw,
                            "elevation_min",
                            "elevationMin",
                            "minimum_elevation",
                            "minimumElevation",
                        )
                    ),
                    "elevation_max_m": self._optional_float(
                        self._first_value(
                            raw,
                            "elevation_max",
                            "elevationMax",
                            "maximum_elevation",
                            "maximumElevation",
                        )
                    ),
                },
                "uses": self._normalize_uses(
                    self._first_value(
                        raw,
                        "uses",
                        "use",
                        "economic_uses",
                        "economicUses",
                    )
                ),
                "traits": self._normalize_traits(
                    self._first_value(
                        raw,
                        "traits",
                        "trait_data",
                        "traitData",
                    )
                ),
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
                    "threats": self._list_value(
                        self._first_value(
                            raw,
                            "threats",
                            "threat",
                        )
                    ),
                },
                "common_names": self._normalize_common_names(
                    self._first_value(
                        raw,
                        "common_names",
                        "commonNames",
                        "vernacular_names",
                        "vernacularNames",
                    )
                ),
                "descriptions": self._list_value(
                    self._first_value(
                        raw,
                        "descriptions",
                        "description",
                    )
                ),
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
        """Extract major plant lineage values."""

        lineage = {
            "kingdom": normalize_space(
                raw.get(
                    "kingdom"
                )
            ) or "Plantae",
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
        """Extract and deduplicate botanical synonyms."""

        values = cls._list_value(
            cls._first_value(
                raw,
                "synonyms",
                "synonym",
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
    def _normalize_regions(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize TDWG, country, and regional distribution records."""

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
                                "region",
                                "area",
                                "country",
                            )
                        ),
                        "code": normalize_space(
                            cls._first_value(
                                item,
                                "code",
                                "tdwg_code",
                                "tdwgCode",
                                "country_code",
                                "countryCode",
                            )
                        ),
                        "level": normalize_space(
                            cls._first_value(
                                item,
                                "level",
                                "tdwg_level",
                                "tdwgLevel",
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
                    }
                )

                if entry.get(
                    "name"
                ) or entry.get(
                    "code"
                ):
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
                            "code": "",
                            "level": "",
                            "status": "",
                        }
                    )

        return result

    @classmethod
    def _normalize_uses(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize economic and ethnobotanical use records."""

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
                        "category": normalize_space(
                            cls._first_value(
                                item,
                                "category",
                                "use_category",
                                "useCategory",
                                "type",
                            )
                        ),
                        "description": normalize_space(
                            cls._first_value(
                                item,
                                "description",
                                "use",
                                "value",
                            )
                        ),
                        "part_used": normalize_space(
                            cls._first_value(
                                item,
                                "part_used",
                                "partUsed",
                            )
                        ),
                    }
                )

                result.append(
                    entry
                )
            else:
                description = normalize_space(
                    item
                )

                if description:
                    result.append(
                        {
                            "category": "",
                            "description": description,
                            "part_used": "",
                        }
                    )

        return result

    @classmethod
    def _normalize_traits(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize structured plant trait records."""

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
                    "trait": normalize_space(
                        cls._first_value(
                            item,
                            "trait",
                            "name",
                            "property",
                            "predicate",
                        )
                    ),
                    "value": cls._first_value(
                        item,
                        "value",
                        "object",
                    ),
                    "unit": normalize_space(
                        cls._first_value(
                            item,
                            "unit",
                        )
                    ),
                }
            )

            if entry.get(
                "trait"
            ):
                result.append(
                    entry
                )

        return result

    @classmethod
    def _normalize_common_names(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize vernacular names with language metadata."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(
            value
        ):
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

                if not name:
                    continue

                result.append(
                    {
                        "name": name,
                        "language": normalize_space(
                            cls._first_value(
                                item,
                                "language",
                                "lang",
                                "locale",
                            )
                        ),
                        "preferred": cls._optional_bool(
                            cls._first_value(
                                item,
                                "preferred",
                                "is_preferred",
                                "isPreferred",
                            )
                        ),
                        "raw": dict(
                            item
                        ),
                    }
                )
            else:
                name = normalize_space(
                    item
                )

                if name:
                    result.append(
                        {
                            "name": name,
                            "language": "",
                            "preferred": None,
                            "raw": item,
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
    def _normalize_identifiers(
        cls,
        value: Any,
    ) -> list[dict[str, str]]:
        """Normalize IPNI, LSID, and external taxonomy identifiers."""

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
        """Normalize botanical references and citations."""

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
        """Normalize botanical taxonomic ranks."""

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
            "subvar.": "subvariety",
            "forma": "form",
            "f.": "form",
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
        """Normalize POWO taxonomic status labels."""

        status = normalize_space(
            value
        ).casefold()

        aliases = {
            "accepted": "accepted",
            "accepted name": "accepted",
            "valid": "valid",
            "synonym": "synonym",
            "unaccepted": "synonym",
            "misapplied": "misapplied",
            "artificial hybrid": "reference",
            "unplaced": "unknown",
            "unresolved": "unknown",
            "doubtful": "unknown",
            "excluded": "excluded",
        }

        return aliases.get(
            status,
            status or "reference",
        )

    @staticmethod
    def _infer_rank(
        scientific_name: str,
    ) -> str:
        """Infer botanical rank from scientific-name structure."""

        words = normalize_space(
            scientific_name
        ).split()

        lowered = {
            word.casefold()
            for word in words
        }

        if "subsp." in lowered or "subspecies" in lowered:
            return "subspecies"

        if "var." in lowered or "variety" in lowered:
            return "variety"

        if "subvar." in lowered or "subvariety" in lowered:
            return "subvariety"

        if "f." in lowered or "forma" in lowered:
            return "form"

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
                f"Invalid POWO cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "POWO cursor must be non-negative."
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
