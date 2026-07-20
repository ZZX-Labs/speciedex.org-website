#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/ncbi_taxonomy.py

NCBI Taxonomy provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It does not assume access to an undocumented,
unlicensed, or unstable public API.

Each source record is normalized into the shared Taxon contract while the
complete NCBI Taxonomy object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "ncbi_taxonomy",
        "path": "static/data/providers/ncbi-taxonomy/taxa.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "NCBI Taxonomy",
        "source_url": "https://www.ncbi.nlm.nih.gov/Taxonomy/"
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
    """File-backed NCBI Taxonomy provider."""

    PROVIDER_NAME = "ncbi_taxonomy"

    DEFAULT_SOURCE_NAME = "NCBI Taxonomy"
    DEFAULT_SOURCE_URL = "https://www.ncbi.nlm.nih.gov/Taxonomy/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable NCBI Taxonomy JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"NCBI Taxonomy export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"NCBI Taxonomy path is not a file: {source_path}"
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
        """Resolve the configured NCBI Taxonomy JSONL source path."""

        configured = normalize_space(
            self.definition.get(
                "path"
            )
        )

        if not configured:
            raise ProviderError(
                "NCBI Taxonomy provider requires a path."
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
        """Normalize one NCBI Taxonomy node or merged-taxid record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "tax_id",
                "taxId",
                "taxID",
                "taxonomy_id",
                "taxonomyId",
                "id",
            )
        )

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "name_txt",
                "nameTxt",
                "name",
            )
        )

        merged_into = normalize_space(
            self._first_value(
                raw,
                "merged_into",
                "mergedInto",
                "new_tax_id",
                "newTaxId",
                "accepted_tax_id",
                "acceptedTaxId",
            )
        )

        is_deleted = self._optional_bool(
            self._first_value(
                raw,
                "deleted",
                "is_deleted",
                "isDeleted",
            )
        )

        if not provider_id:
            return None

        if not scientific_name:
            if merged_into:
                scientific_name = (
                    f"NCBI Taxonomy merged taxon {provider_id}"
                )
            elif is_deleted:
                scientific_name = (
                    f"NCBI Taxonomy deleted taxon {provider_id}"
                )
            else:
                return None

        canonical_name = normalize_space(
            self._first_value(
                raw,
                "canonical_name",
                "canonicalName",
                "scientific_name",
                "scientificName",
                "name_txt",
                "nameTxt",
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

        status = self._normalize_status(
            raw,
            merged_into=merged_into,
            is_deleted=is_deleted,
        )

        accepted_provider_id = merged_into

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
                "https://www.ncbi.nlm.nih.gov/Taxonomy/"
                "Browser/wwwtax.cgi?id="
                + provider_id
            )

        lineage = self._extract_lineage(
            raw
        )

        names = self._normalize_names(
            self._first_value(
                raw,
                "names",
                "name_records",
                "nameRecords",
                "synonyms",
                "other_names",
                "otherNames",
            ),
            scientific_name=scientific_name,
        )

        synonyms = [
            item["name"]
            for item in names
            if item["name_class"] in {
                "synonym",
                "equivalent name",
                "includes",
                "in-part",
                "misspelling",
                "misnomer",
                "authority",
                "genbank synonym",
            }
            and item["name"].casefold()
            != scientific_name.casefold()
        ]

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
            synonyms=self._deduplicate_strings(
                synonyms
            ),
            extra={
                "source": normalize_space(
                    self.definition.get(
                        "source_name",
                        self.DEFAULT_SOURCE_NAME,
                    )
                ) or self.DEFAULT_SOURCE_NAME,
                "programme": "ncbi_taxonomy",
                "reference_only": True,
                "tax_id": provider_id,
                "merged_into_tax_id": merged_into,
                "deleted": is_deleted,
                "parent_tax_id": normalize_space(
                    self._first_value(
                        raw,
                        "parent_tax_id",
                        "parentTaxId",
                        "parent_id",
                        "parentId",
                    )
                ),
                "lineage": lineage,
                "lineage_tax_ids": self._normalize_lineage_tax_ids(
                    self._first_value(
                        raw,
                        "lineage_tax_ids",
                        "lineageTaxIds",
                        "lineage_ids",
                        "lineageIds",
                    )
                ),
                "names": names,
                "common_names": [
                    item
                    for item in names
                    if item["name_class"] in {
                        "common name",
                        "genbank common name",
                    }
                ],
                "genbank_names": [
                    item
                    for item in names
                    if item["name_class"].startswith(
                        "genbank"
                    )
                ],
                "division": {
                    "id": normalize_space(
                        self._first_value(
                            raw,
                            "division_id",
                            "divisionId",
                        )
                    ),
                    "code": normalize_space(
                        self._first_value(
                            raw,
                            "division_code",
                            "divisionCode",
                        )
                    ),
                    "name": normalize_space(
                        self._first_value(
                            raw,
                            "division_name",
                            "divisionName",
                        )
                    ),
                    "inherited": self._optional_bool(
                        self._first_value(
                            raw,
                            "inherited_division",
                            "inheritedDivision",
                        )
                    ),
                },
                "genetic_code": {
                    "id": normalize_space(
                        self._first_value(
                            raw,
                            "genetic_code_id",
                            "geneticCodeId",
                            "gencode_id",
                            "gencodeId",
                        )
                    ),
                    "name": normalize_space(
                        self._first_value(
                            raw,
                            "genetic_code_name",
                            "geneticCodeName",
                            "gencode_name",
                            "gencodeName",
                        )
                    ),
                    "inherited": self._optional_bool(
                        self._first_value(
                            raw,
                            "inherited_genetic_code",
                            "inheritedGeneticCode",
                        )
                    ),
                },
                "mitochondrial_genetic_code": {
                    "id": normalize_space(
                        self._first_value(
                            raw,
                            "mitochondrial_genetic_code_id",
                            "mitochondrialGeneticCodeId",
                            "mito_gencode_id",
                            "mitoGencodeId",
                        )
                    ),
                    "name": normalize_space(
                        self._first_value(
                            raw,
                            "mitochondrial_genetic_code_name",
                            "mitochondrialGeneticCodeName",
                            "mito_gencode_name",
                            "mitoGencodeName",
                        )
                    ),
                    "inherited": self._optional_bool(
                        self._first_value(
                            raw,
                            "inherited_mitochondrial_genetic_code",
                            "inheritedMitochondrialGeneticCode",
                        )
                    ),
                },
                "plastid_genetic_code": {
                    "id": normalize_space(
                        self._first_value(
                            raw,
                            "plastid_genetic_code_id",
                            "plastidGeneticCodeId",
                            "plastid_gencode_id",
                            "plastidGencodeId",
                        )
                    ),
                    "name": normalize_space(
                        self._first_value(
                            raw,
                            "plastid_genetic_code_name",
                            "plastidGeneticCodeName",
                            "plastid_gencode_name",
                            "plastidGencodeName",
                        )
                    ),
                },
                "hidden_subtree_root": self._optional_bool(
                    self._first_value(
                        raw,
                        "hidden_subtree_root",
                        "hiddenSubtreeRoot",
                    )
                ),
                "environmental_sample": self._optional_bool(
                    self._first_value(
                        raw,
                        "environmental_sample",
                        "environmentalSample",
                    )
                ),
                "uncultured": self._optional_bool(
                    self._first_value(
                        raw,
                        "uncultured",
                        "is_uncultured",
                        "isUncultured",
                    )
                ),
                "type_material": self._list_value(
                    self._first_value(
                        raw,
                        "type_material",
                        "typeMaterial",
                        "type_specimens",
                        "typeSpecimens",
                    )
                ),
                "citations": self._normalize_citations(
                    self._first_value(
                        raw,
                        "citations",
                        "citation",
                        "references",
                    )
                ),
                "properties": self._first_mapping(
                    raw,
                    "properties",
                    "attributes",
                    "metadata",
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
        """Extract major lineage names from direct fields or lineage entries."""

        lineage = {
            "domain": normalize_space(
                raw.get(
                    "domain"
                )
            ),
            "superkingdom": normalize_space(
                raw.get(
                    "superkingdom"
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
            "species": normalize_space(
                raw.get(
                    "species"
                )
            ),
        }

        lineage_value = cls._first_value(
            raw,
            "lineage",
            "classification",
            "ancestors",
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
                    "scientific_name",
                    "scientificName",
                    "name",
                )
            )

            if rank and name and not lineage.get(
                rank
            ):
                lineage[
                    rank
                ] = name

        if (
            not lineage.get(
                "domain"
            )
            and lineage.get(
                "superkingdom"
            )
        ):
            lineage[
                "domain"
            ] = lineage[
                "superkingdom"
            ]

        return lineage

    @classmethod
    def _normalize_names(
        cls,
        value: Any,
        *,
        scientific_name: str,
    ) -> list[dict[str, Any]]:
        """Normalize NCBI name records and name classes."""

        result: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()

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
                        "name_txt",
                        "nameTxt",
                        "value",
                    )
                )

                name_class = normalize_space(
                    cls._first_value(
                        item,
                        "name_class",
                        "nameClass",
                        "class",
                        "type",
                    )
                ).casefold()

                unique_name = normalize_space(
                    cls._first_value(
                        item,
                        "unique_name",
                        "uniqueName",
                    )
                )

                raw = dict(
                    item
                )
            else:
                name = normalize_space(
                    item
                )
                name_class = "synonym"
                unique_name = ""
                raw = item

            if not name:
                continue

            if (
                name.casefold()
                == scientific_name.casefold()
                and not name_class
            ):
                name_class = "scientific name"

            key = (
                name.casefold(),
                name_class,
            )

            if key in seen:
                continue

            seen.add(
                key
            )

            result.append(
                {
                    "name": name,
                    "unique_name": unique_name,
                    "name_class": name_class,
                    "raw": raw,
                }
            )

        if not any(
            item["name"].casefold()
            == scientific_name.casefold()
            and item["name_class"]
            == "scientific name"
            for item in result
        ):
            result.insert(
                0,
                {
                    "name": scientific_name,
                    "unique_name": "",
                    "name_class": "scientific name",
                    "raw": scientific_name,
                },
            )

        return result

    @classmethod
    def _normalize_citations(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize NCBI taxonomy citations and publication identifiers."""

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
                        "citation_id": normalize_space(
                            cls._first_value(
                                item,
                                "citation_id",
                                "citationId",
                                "id",
                            )
                        ),
                        "text": normalize_space(
                            cls._first_value(
                                item,
                                "text",
                                "citation",
                                "title",
                            )
                        ),
                        "pubmed_ids": cls._normalize_id_list(
                            cls._first_value(
                                item,
                                "pubmed_ids",
                                "pubmedIds",
                                "pmids",
                            )
                        ),
                        "medline_ids": cls._normalize_id_list(
                            cls._first_value(
                                item,
                                "medline_ids",
                                "medlineIds",
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
                text = normalize_space(
                    item
                )

                if text:
                    result.append(
                        {
                            "citation_id": "",
                            "text": text,
                            "pubmed_ids": [],
                            "medline_ids": [],
                            "url": "",
                        }
                    )

        return result

    @classmethod
    def _normalize_lineage_tax_ids(
        cls,
        value: Any,
    ) -> list[str]:
        """Normalize lineage TaxID sequences."""

        if isinstance(
            value,
            str,
        ):
            values = [
                item
                for item in value.replace(
                    ";",
                    " ",
                ).replace(
                    ",",
                    " ",
                ).split()
                if item
            ]
        else:
            values = cls._list_value(
                value
            )

        return cls._deduplicate_strings(
            normalize_space(
                item
            )
            for item in values
        )

    @classmethod
    def _normalize_id_list(
        cls,
        value: Any,
    ) -> list[str]:
        """Normalize scalar or delimited identifier lists."""

        if isinstance(
            value,
            str,
        ):
            values = [
                item
                for item in value.replace(
                    ";",
                    " ",
                ).replace(
                    ",",
                    " ",
                ).split()
                if item
            ]
        else:
            values = cls._list_value(
                value
            )

        return cls._deduplicate_strings(
            normalize_space(
                item
            )
            for item in values
        )

    @staticmethod
    def _normalize_status(
        raw: Mapping[str, Any],
        *,
        merged_into: str,
        is_deleted: bool | None,
    ) -> str:
        """Determine NCBI taxonomic record status."""

        if merged_into:
            return "merged"

        if is_deleted:
            return "deleted"

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
            "merged": "merged",
            "deleted": "deleted",
            "inactive": "inactive",
            "reference": "reference",
        }

        return aliases.get(
            status,
            status or "accepted",
        )

    @staticmethod
    def _normalize_rank(
        value: Any,
    ) -> str:
        """Normalize NCBI rank labels."""

        rank = normalize_space(
            value
        ).casefold().replace(
            "_",
            " ",
        )

        aliases = {
            "no rank": "unranked",
            "species group": "species_group",
            "species subgroup": "species_subgroup",
            "forma specialis": "forma_specialis",
            "sub species": "subspecies",
            "super kingdom": "superkingdom",
        }

        return aliases.get(
            rank,
            rank.replace(
                " ",
                "_",
            ) if rank else "unranked",
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
                f"Invalid NCBI Taxonomy cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "NCBI Taxonomy cursor must be non-negative."
            )

        return offset

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
    def _deduplicate_strings(
        values: Any,
    ) -> list[str]:
        """Normalize and deduplicate string-like values."""

        result: list[str] = []
        seen: set[str] = set()

        for value in values:
            normalized = normalize_space(
                value
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
