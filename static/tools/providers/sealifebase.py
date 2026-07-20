#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/sealifebase.py

SeaLifeBase provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It does not assume access to an undocumented,
unlicensed, or unstable public API.

Each source record is normalized into the shared Taxon contract while the
complete SeaLifeBase object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "sealifebase",
        "path": "static/data/providers/sealifebase/species.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "SeaLifeBase",
        "source_url": "https://www.sealifebase.ca/"
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
    """File-backed SeaLifeBase provider."""

    PROVIDER_NAME = "sealifebase"

    DEFAULT_SOURCE_NAME = "SeaLifeBase"
    DEFAULT_SOURCE_URL = "https://www.sealifebase.ca/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable SeaLifeBase JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"SeaLifeBase export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"SeaLifeBase path is not a file: {source_path}"
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
        """Resolve the configured SeaLifeBase JSONL source path."""

        configured = normalize_space(
            self.definition.get(
                "path"
            )
        )

        if not configured:
            raise ProviderError(
                "SeaLifeBase provider requires a path."
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
        """Normalize one SeaLifeBase species record."""

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
                "programme": "sealifebase",
                "reference_only": True,
                "spec_code": provider_id,
                "accepted_spec_code": accepted_provider_id,
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
                    "brackish": self._optional_bool(
                        self._first_value(
                            raw,
                            "brackish",
                            "is_brackish",
                            "isBrackish",
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
                    "benthic": self._optional_bool(
                        self._first_value(
                            raw,
                            "benthic",
                            "is_benthic",
                            "isBenthic",
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
                "distribution": {
                    "summary": self._first_value(
                        raw,
                        "distribution",
                        "geographic_distribution",
                        "geographicDistribution",
                        "range",
                    ),
                    "countries": self._list_value(
                        self._first_value(
                            raw,
                            "countries",
                            "country",
                        )
                    ),
                    "regions": self._list_value(
                        self._first_value(
                            raw,
                            "regions",
                            "region",
                        )
                    ),
                    "ecosystems": self._list_value(
                        self._first_value(
                            raw,
                            "ecosystems",
                            "ecosystem",
                        )
                    ),
                },
                "habitats": self._list_value(
                    self._first_value(
                        raw,
                        "habitats",
                        "habitat",
                    )
                ),
                "depth": {
                    "minimum_m": self._optional_float(
                        self._first_value(
                            raw,
                            "depth_min",
                            "depthMin",
                            "minimum_depth",
                            "minimumDepth",
                        )
                    ),
                    "maximum_m": self._optional_float(
                        self._first_value(
                            raw,
                            "depth_max",
                            "depthMax",
                            "maximum_depth",
                            "maximumDepth",
                        )
                    ),
                    "common_minimum_m": self._optional_float(
                        self._first_value(
                            raw,
                            "common_depth_min",
                            "commonDepthMin",
                        )
                    ),
                    "common_maximum_m": self._optional_float(
                        self._first_value(
                            raw,
                            "common_depth_max",
                            "commonDepthMax",
                        )
                    ),
                },
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
                            "movement",
                        )
                    ),
                    "sociality": normalize_space(
                        self._first_value(
                            raw,
                            "sociality",
                            "social_behavior",
                            "socialBehavior",
                        )
                    ),
                    "symbiosis": self._list_value(
                        self._first_value(
                            raw,
                            "symbiosis",
                            "associations",
                        )
                    ),
                    "host": self._list_value(
                        self._first_value(
                            raw,
                            "host",
                            "hosts",
                        )
                    ),
                },
                "morphology": {
                    "length_max_cm": self._optional_float(
                        self._first_value(
                            raw,
                            "length_max",
                            "lengthMax",
                            "maximum_length",
                            "maximumLength",
                        )
                    ),
                    "width_max_cm": self._optional_float(
                        self._first_value(
                            raw,
                            "width_max",
                            "widthMax",
                            "maximum_width",
                            "maximumWidth",
                        )
                    ),
                    "weight_max_kg": self._optional_float(
                        self._first_value(
                            raw,
                            "weight_max",
                            "weightMax",
                            "maximum_weight",
                            "maximumWeight",
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
                    "diagnosis": normalize_space(
                        self._first_value(
                            raw,
                            "diagnosis",
                            "diagnostic_features",
                            "diagnosticFeatures",
                        )
                    ),
                },
                "life_history": {
                    "longevity_years": self._optional_float(
                        self._first_value(
                            raw,
                            "longevity",
                            "max_age",
                            "maxAge",
                        )
                    ),
                    "generation_time_years": self._optional_float(
                        self._first_value(
                            raw,
                            "generation_time",
                            "generationTime",
                        )
                    ),
                    "maturity_age_years": self._optional_float(
                        self._first_value(
                            raw,
                            "maturity_age",
                            "maturityAge",
                        )
                    ),
                    "maturity_size_cm": self._optional_float(
                        self._first_value(
                            raw,
                            "maturity_size",
                            "maturitySize",
                        )
                    ),
                    "growth_form": normalize_space(
                        self._first_value(
                            raw,
                            "growth_form",
                            "growthForm",
                        )
                    ),
                    "growth_rate": normalize_space(
                        self._first_value(
                            raw,
                            "growth_rate",
                            "growthRate",
                        )
                    ),
                },
                "reproduction": {
                    "mode": normalize_space(
                        self._first_value(
                            raw,
                            "reproductive_mode",
                            "reproductiveMode",
                            "reproduction",
                        )
                    ),
                    "fertilization": normalize_space(
                        self._first_value(
                            raw,
                            "fertilization",
                            "fertilization_type",
                            "fertilizationType",
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
                    "fecundity": self._optional_float(
                        self._first_value(
                            raw,
                            "fecundity",
                        )
                    ),
                    "larval_duration_days": self._optional_float(
                        self._first_value(
                            raw,
                            "larval_duration",
                            "larvalDuration",
                        )
                    ),
                },
                "human_uses": {
                    "fisheries_importance": normalize_space(
                        self._first_value(
                            raw,
                            "fisheries_importance",
                            "fisheriesImportance",
                            "fishery_importance",
                            "fisheryImportance",
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
                    "ornamental": self._optional_bool(
                        self._first_value(
                            raw,
                            "ornamental",
                            "used_as_ornamental",
                            "usedAsOrnamental",
                        )
                    ),
                    "human_consumption": self._optional_bool(
                        self._first_value(
                            raw,
                            "human_consumption",
                            "humanConsumption",
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
                    "medical": self._optional_bool(
                        self._first_value(
                            raw,
                            "medical",
                            "medicinal",
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
                    "cites_status": normalize_space(
                        self._first_value(
                            raw,
                            "cites_status",
                            "citesStatus",
                            "cites",
                        )
                    ),
                    "cms_status": normalize_space(
                        self._first_value(
                            raw,
                            "cms_status",
                            "cmsStatus",
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
                    "vulnerability": self._optional_float(
                        self._first_value(
                            raw,
                            "vulnerability",
                            "vulnerability_score",
                            "vulnerabilityScore",
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
        *,
        genus: str,
    ) -> dict[str, str]:
        """Extract marine-organism lineage from direct or nested fields."""

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
        """Normalize image and media metadata."""

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
        """Normalize external taxonomy identifiers."""

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
        """Normalize SeaLifeBase references and citations."""

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
                            "reference_id": "",
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
            "sub species": "subspecies",
            "sub genus": "subgenus",
            "sub family": "subfamily",
            "sub order": "suborder",
            "sub class": "subclass",
            "sub phylum": "subphylum",
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
    def _normalize_status(
        value: Any,
    ) -> str:
        """Normalize SeaLifeBase taxonomic status values."""

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
                f"Invalid SeaLifeBase cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "SeaLifeBase cursor must be non-negative."
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
