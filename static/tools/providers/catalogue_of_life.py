#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/catalogue_of_life.py

Catalogue of Life / ChecklistBank provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It does not assume access to an undocumented or
unlicensed public API.

Each source record is normalized into the shared Taxon contract while the
complete source object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "catalogue_of_life",
        "path": "static/data/providers/catalogue-of-life/taxa.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "Catalogue of Life / ChecklistBank",
        "source_url": "https://www.catalogueoflife.org/"
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
    """File-backed Catalogue of Life / ChecklistBank provider."""

    PROVIDER_NAME = "catalogue_of_life"

    DEFAULT_SOURCE_NAME = "Catalogue of Life / ChecklistBank"
    DEFAULT_SOURCE_URL = "https://www.catalogueoflife.org/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"Catalogue of Life export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"Catalogue of Life path is not a file: {source_path}"
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
                "Catalogue of Life provider requires a path."
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
        """Normalize one Catalogue of Life / ChecklistBank record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "taxon_id",
                "taxonId",
                "taxonID",
                "usage_id",
                "usageId",
                "usageID",
                "id",
                "key",
            )
        )

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "name",
                "label",
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
                "name_status",
                "nameStatus",
            )
        )

        accepted_provider_id = normalize_space(
            self._first_value(
                raw,
                "accepted_taxon_id",
                "acceptedTaxonId",
                "acceptedTaxonID",
                "accepted_id",
                "acceptedId",
                "acceptedID",
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
                    "scientific_name_authorship",
                    "scientificNameAuthorship",
                    "author",
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
                "programme": "catalogue_of_life",
                "reference_only": True,
                "taxon_id": provider_id,
                "accepted_taxon_id": accepted_provider_id,
                "dataset": {
                    "id": normalize_space(
                        self._first_value(
                            raw,
                            "dataset_id",
                            "datasetId",
                            "datasetID",
                            "source_dataset_id",
                            "sourceDatasetId",
                        )
                    ),
                    "key": normalize_space(
                        self._first_value(
                            raw,
                            "dataset_key",
                            "datasetKey",
                        )
                    ),
                    "title": normalize_space(
                        self._first_value(
                            raw,
                            "dataset_title",
                            "datasetTitle",
                            "dataset_name",
                            "datasetName",
                        )
                    ),
                    "version": normalize_space(
                        self._first_value(
                            raw,
                            "dataset_version",
                            "datasetVersion",
                            "version",
                        )
                    ),
                    "release_date": normalize_space(
                        self._first_value(
                            raw,
                            "release_date",
                            "releaseDate",
                        )
                    ),
                },
                "name": {
                    "type": normalize_space(
                        self._first_value(
                            raw,
                            "name_type",
                            "nameType",
                        )
                    ),
                    "status": normalize_space(
                        self._first_value(
                            raw,
                            "name_status",
                            "nameStatus",
                            "nomenclatural_status",
                            "nomenclaturalStatus",
                        )
                    ),
                    "code": normalize_space(
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
                            "name_published_in",
                            "namePublishedIn",
                        )
                    ),
                },
                "lineage": lineage,
                "parent": {
                    "id": normalize_space(
                        self._first_value(
                            raw,
                            "parent_taxon_id",
                            "parentTaxonId",
                            "parentTaxonID",
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
                "basionym_id": normalize_space(
                    self._first_value(
                        raw,
                        "basionym_id",
                        "basionymId",
                        "basionymID",
                    )
                ),
                "original_name_id": normalize_space(
                    self._first_value(
                        raw,
                        "original_name_id",
                        "originalNameId",
                        "originalNameID",
                    )
                ),
                "scrutinizer": normalize_space(
                    self._first_value(
                        raw,
                        "scrutinizer",
                    )
                ),
                "scrutinizer_date": normalize_space(
                    self._first_value(
                        raw,
                        "scrutinizer_date",
                        "scrutinizerDate",
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
                "environment": self._list_value(
                    self._first_value(
                        raw,
                        "environment",
                        "environments",
                    )
                ),
                "distribution": self._list_value(
                    self._first_value(
                        raw,
                        "distribution",
                        "distributions",
                    )
                ),
                "vernacular_names": self._list_value(
                    self._first_value(
                        raw,
                        "vernacular_names",
                        "vernacularNames",
                        "common_names",
                        "commonNames",
                    )
                ),
                "references": self._list_value(
                    self._first_value(
                        raw,
                        "references",
                        "reference",
                    )
                ),
                "issues": self._list_value(
                    self._first_value(
                        raw,
                        "issues",
                        "issue",
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
        """Extract major lineage values from direct fields or lineage arrays."""

        lineage: dict[str, str] = {
            "domain": normalize_space(
                raw.get(
                    "domain"
                )
            ),
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
                        "canonical_name",
                        "canonicalName",
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

    @staticmethod
    def _normalize_status(
        value: Any,
    ) -> str:
        """Normalize Catalogue of Life taxonomic status terms."""

        status = normalize_space(
            value
        ).casefold()

        aliases = {
            "accepted": "accepted",
            "provisionally accepted": "provisionally accepted",
            "synonym": "synonym",
            "ambiguous synonym": "synonym",
            "misapplied": "misapplied",
            "unresolved": "unknown",
            "doubtful": "unknown",
            "excluded": "excluded",
        }

        return aliases.get(
            status,
            status or "unknown",
        )

    @staticmethod
    def _decode_cursor(
        cursor: str | None,
    ) -> int:
        """Decode a non-negative line offset."""

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
                f"Invalid Catalogue of Life cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "Catalogue of Life cursor must be non-negative."
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
