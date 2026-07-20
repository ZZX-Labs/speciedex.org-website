#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/biodiversity_heritage_library.py

Biodiversity Heritage Library (BHL) provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It is intended for biodiversity literature, title,
item, part, page, article, author, taxonomic-name, OCR, illustration, citation,
rights, and provenance metadata.

Each source record is normalized into the shared Speciedex Taxon contract when
a taxonomic name or taxon concept can be resolved. Literature-only records are
preserved as reference-oriented Taxon records when configured to do so.

Required provider configuration:

    {
        "name": "biodiversity_heritage_library",
        "path": "static/data/providers/bhl/records.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "Biodiversity Heritage Library",
        "source_url": "https://www.biodiversitylibrary.org/",
        "allow_reference_only_records": true
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
    """File-backed Biodiversity Heritage Library provider."""

    PROVIDER_NAME = "biodiversity_heritage_library"

    DEFAULT_SOURCE_NAME = "Biodiversity Heritage Library"
    DEFAULT_SOURCE_URL = "https://www.biodiversitylibrary.org/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable BHL JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"BHL export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"BHL path is not a file: {source_path}"
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
                            f"Invalid BHL JSON at "
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
        """Resolve the configured BHL JSONL source path."""

        configured = normalize_space(
            self.definition.get("path")
            or self.definition.get("file")
            or self.definition.get("source_path")
        )

        if not configured:
            raise ProviderError(
                "Biodiversity Heritage Library provider requires a path."
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
        """Normalize one BHL taxonomic or literature record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "bhl_name_id",
                "bhlNameId",
                "name_id",
                "nameId",
                "taxon_id",
                "taxonId",
                "part_id",
                "partId",
                "page_id",
                "pageId",
                "item_id",
                "itemId",
                "title_id",
                "titleId",
                "id",
            )
        )

        scientific_name = normalize_space(
            self._first_value(
                raw,
                "scientific_name",
                "scientificName",
                "taxon_name",
                "taxonName",
                "name",
                "name_string",
                "nameString",
            )
        )

        allow_reference_only = bool(
            self.definition.get(
                "allow_reference_only_records",
                True,
            )
        )

        if not scientific_name and allow_reference_only:
            scientific_name = self._fallback_reference_name(raw)

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
                "name_rank",
                "nameRank",
            )
        )

        if rank == "unknown":
            rank = (
                self._infer_rank(canonical_name)
                if self._looks_taxonomic(scientific_name)
                else "reference"
            )

        status = self._normalize_status(
            self._first_value(
                raw,
                "status",
                "taxonomic_status",
                "taxonomicStatus",
                "name_status",
                "nameStatus",
            ),
            taxonomic=self._looks_taxonomic(scientific_name),
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
                "bhl_url",
                "bhlUrl",
            )
        )

        if not source_url:
            source_url = self._build_source_url(raw, provider_id)

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
                    "authorship",
                    "scientific_name_authorship",
                    "scientificNameAuthorship",
                    "authority",
                    "author",
                )
            ),
            kingdom=lineage.get("kingdom", ""),
            phylum=lineage.get("phylum", ""),
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
                "programme": "biodiversity_heritage_library",
                "reference_only": not self._looks_taxonomic(scientific_name),
                "bhl_identifiers": {
                    "name_id": normalize_space(
                        self._first_value(
                            raw,
                            "bhl_name_id",
                            "bhlNameId",
                            "name_id",
                            "nameId",
                        )
                    ),
                    "title_id": normalize_space(
                        self._first_value(
                            raw,
                            "title_id",
                            "titleId",
                        )
                    ),
                    "item_id": normalize_space(
                        self._first_value(
                            raw,
                            "item_id",
                            "itemId",
                        )
                    ),
                    "part_id": normalize_space(
                        self._first_value(
                            raw,
                            "part_id",
                            "partId",
                        )
                    ),
                    "page_id": normalize_space(
                        self._first_value(
                            raw,
                            "page_id",
                            "pageId",
                        )
                    ),
                    "segment_id": normalize_space(
                        self._first_value(
                            raw,
                            "segment_id",
                            "segmentId",
                        )
                    ),
                },
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
                "title": self._normalize_title(raw),
                "item": self._normalize_item(raw),
                "part": self._normalize_part(raw),
                "page": self._normalize_page(raw),
                "article": self._normalize_article(raw),
                "taxonomy": {
                    "name_found": normalize_space(
                        self._first_value(
                            raw,
                            "name_found",
                            "nameFound",
                            "verbatim_name",
                            "verbatimName",
                        )
                    ),
                    "name_source": normalize_space(
                        self._first_value(
                            raw,
                            "name_source",
                            "nameSource",
                        )
                    ),
                    "name_bank_id": normalize_space(
                        self._first_value(
                            raw,
                            "name_bank_id",
                            "nameBankId",
                        )
                    ),
                    "taxonomic_notes": normalize_space(
                        self._first_value(
                            raw,
                            "taxonomic_notes",
                            "taxonomicNotes",
                            "comments",
                        )
                    ),
                    "occurrence_count": self._optional_int(
                        self._first_value(
                            raw,
                            "name_occurrence_count",
                            "nameOccurrenceCount",
                            "occurrence_count",
                            "occurrenceCount",
                        )
                    ),
                },
                "name_occurrences": self._normalize_name_occurrences(
                    self._first_value(
                        raw,
                        "name_occurrences",
                        "nameOccurrences",
                        "taxon_name_occurrences",
                        "taxonNameOccurrences",
                    )
                ),
                "authors": self._normalize_authors(
                    self._first_value(
                        raw,
                        "authors",
                        "author_records",
                        "authorRecords",
                        "creators",
                    )
                ),
                "subjects": self._normalize_subjects(
                    self._first_value(
                        raw,
                        "subjects",
                        "subject",
                        "keywords",
                    )
                ),
                "ocr": {
                    "text": self._first_value(
                        raw,
                        "ocr_text",
                        "ocrText",
                        "text",
                        "page_text",
                        "pageText",
                    ),
                    "language": normalize_space(
                        self._first_value(
                            raw,
                            "ocr_language",
                            "ocrLanguage",
                            "language",
                        )
                    ),
                    "quality": normalize_space(
                        self._first_value(
                            raw,
                            "ocr_quality",
                            "ocrQuality",
                        )
                    ),
                    "word_count": self._optional_int(
                        self._first_value(
                            raw,
                            "ocr_word_count",
                            "ocrWordCount",
                            "word_count",
                            "wordCount",
                        )
                    ),
                },
                "media": self._normalize_media(
                    self._first_value(
                        raw,
                        "media",
                        "images",
                        "image",
                        "illustrations",
                        "plates",
                    )
                ),
                "rights": {
                    "license": normalize_space(
                        self._first_value(
                            raw,
                            "license",
                            "rights",
                        )
                    ),
                    "rights_holder": normalize_space(
                        self._first_value(
                            raw,
                            "rights_holder",
                            "rightsHolder",
                        )
                    ),
                    "copyright_status": normalize_space(
                        self._first_value(
                            raw,
                            "copyright_status",
                            "copyrightStatus",
                        )
                    ),
                    "access_rights": normalize_space(
                        self._first_value(
                            raw,
                            "access_rights",
                            "accessRights",
                        )
                    ),
                    "attribution": normalize_space(
                        self._first_value(
                            raw,
                            "attribution",
                            "credit",
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
                        "bibliography",
                        "citations",
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

    def _build_source_url(
        self,
        raw: Mapping[str, Any],
        provider_id: str,
    ) -> str:
        """Build the most specific BHL URL available."""

        base = normalize_space(
            self.definition.get(
                "source_url",
                self.DEFAULT_SOURCE_URL,
            )
        ).rstrip("/")

        page_id = normalize_space(
            self._first_value(raw, "page_id", "pageId")
        )
        part_id = normalize_space(
            self._first_value(raw, "part_id", "partId")
        )
        item_id = normalize_space(
            self._first_value(raw, "item_id", "itemId")
        )
        title_id = normalize_space(
            self._first_value(raw, "title_id", "titleId")
        )
        name_id = normalize_space(
            self._first_value(
                raw,
                "bhl_name_id",
                "bhlNameId",
                "name_id",
                "nameId",
            )
        )

        if page_id:
            return f"{base}/page/{page_id}"

        if part_id:
            return f"{base}/part/{part_id}"

        if item_id:
            return f"{base}/item/{item_id}"

        if title_id:
            return f"{base}/bibliography/{title_id}"

        if name_id:
            return f"{base}/name/{name_id}"

        return f"{base}/{provider_id}"

    @classmethod
    def _fallback_reference_name(
        cls,
        raw: Mapping[str, Any],
    ) -> str:
        """Generate a descriptive reference name for literature-only rows."""

        title = normalize_space(
            cls._first_value(
                raw,
                "part_title",
                "partTitle",
                "article_title",
                "articleTitle",
                "title",
                "title_name",
                "titleName",
            )
        )

        if title:
            return title

        page_number = normalize_space(
            cls._first_value(
                raw,
                "page_number",
                "pageNumber",
            )
        )

        if page_number:
            return f"BHL page {page_number}"

        provider_id = normalize_space(
            cls._first_value(
                raw,
                "page_id",
                "pageId",
                "part_id",
                "partId",
                "item_id",
                "itemId",
                "title_id",
                "titleId",
                "id",
            )
        )

        return f"BHL record {provider_id}" if provider_id else ""

    @staticmethod
    def _looks_taxonomic(value: str) -> bool:
        """Heuristically distinguish taxon names from literature titles."""

        text = normalize_space(value)

        if not text:
            return False

        words = text.split()

        if len(words) in {1, 2, 3, 4}:
            if all(
                word[:1].isalpha()
                for word in words
                if word
            ):
                return True

        return False

    @classmethod
    def _extract_lineage(
        cls,
        raw: Mapping[str, Any],
    ) -> dict[str, str]:
        """Extract taxonomic lineage when supplied by BHL enrichment."""

        lineage = {
            "kingdom": normalize_space(raw.get("kingdom")),
            "phylum": normalize_space(raw.get("phylum")),
            "class": normalize_space(raw.get("class")),
            "order": normalize_space(raw.get("order")),
            "family": normalize_space(raw.get("family")),
            "genus": normalize_space(raw.get("genus")),
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
        """Extract and deduplicate taxonomic synonyms."""

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
        seen: set[str] = set(excluded)

        for item in values:
            if isinstance(item, Mapping):
                value = normalize_space(
                    cls._first_value(
                        item,
                        "scientific_name",
                        "scientificName",
                        "name",
                        "value",
                    )
                )
            else:
                value = normalize_space(item)

            key = value.casefold()

            if not value or key in seen:
                continue

            seen.add(key)
            result.append(value)

        return result

    @classmethod
    def _normalize_title(
        cls,
        raw: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Normalize BHL title-level metadata."""

        return {
            "title_id": normalize_space(
                cls._first_value(raw, "title_id", "titleId")
            ),
            "title": normalize_space(
                cls._first_value(
                    raw,
                    "title",
                    "title_name",
                    "titleName",
                    "full_title",
                    "fullTitle",
                )
            ),
            "short_title": normalize_space(
                cls._first_value(
                    raw,
                    "short_title",
                    "shortTitle",
                )
            ),
            "translated_title": normalize_space(
                cls._first_value(
                    raw,
                    "translated_title",
                    "translatedTitle",
                )
            ),
            "publication_details": normalize_space(
                cls._first_value(
                    raw,
                    "publication_details",
                    "publicationDetails",
                )
            ),
            "publisher": normalize_space(
                cls._first_value(
                    raw,
                    "publisher",
                    "publisher_name",
                    "publisherName",
                )
            ),
            "publication_place": normalize_space(
                cls._first_value(
                    raw,
                    "publication_place",
                    "publicationPlace",
                )
            ),
            "start_year": normalize_space(
                cls._first_value(
                    raw,
                    "start_year",
                    "startYear",
                )
            ),
            "end_year": normalize_space(
                cls._first_value(
                    raw,
                    "end_year",
                    "endYear",
                )
            ),
            "language": normalize_space(
                cls._first_value(raw, "language")
            ),
            "edition": normalize_space(
                cls._first_value(raw, "edition")
            ),
            "frequency": normalize_space(
                cls._first_value(raw, "frequency")
            ),
            "issn": normalize_space(
                cls._first_value(raw, "issn")
            ),
            "oclc": normalize_space(
                cls._first_value(
                    raw,
                    "oclc",
                    "oclc_number",
                    "oclcNumber",
                )
            ),
        }

    @classmethod
    def _normalize_item(
        cls,
        raw: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Normalize BHL item-level metadata."""

        return {
            "item_id": normalize_space(
                cls._first_value(raw, "item_id", "itemId")
            ),
            "title_id": normalize_space(
                cls._first_value(raw, "title_id", "titleId")
            ),
            "volume": normalize_space(
                cls._first_value(raw, "volume")
            ),
            "issue": normalize_space(
                cls._first_value(raw, "issue")
            ),
            "year": normalize_space(
                cls._first_value(
                    raw,
                    "year",
                    "publication_year",
                    "publicationYear",
                )
            ),
            "holding_institution": normalize_space(
                cls._first_value(
                    raw,
                    "holding_institution",
                    "holdingInstitution",
                )
            ),
            "contributor": normalize_space(
                cls._first_value(
                    raw,
                    "contributor",
                    "contributor_name",
                    "contributorName",
                )
            ),
            "barcode": normalize_space(
                cls._first_value(raw, "barcode")
            ),
            "rights": normalize_space(
                cls._first_value(
                    raw,
                    "item_rights",
                    "itemRights",
                )
            ),
            "scanning_center": normalize_space(
                cls._first_value(
                    raw,
                    "scanning_center",
                    "scanningCenter",
                )
            ),
        }

    @classmethod
    def _normalize_part(
        cls,
        raw: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Normalize BHL part or segment metadata."""

        return {
            "part_id": normalize_space(
                cls._first_value(raw, "part_id", "partId")
            ),
            "title": normalize_space(
                cls._first_value(
                    raw,
                    "part_title",
                    "partTitle",
                    "article_title",
                    "articleTitle",
                )
            ),
            "type": normalize_space(
                cls._first_value(
                    raw,
                    "part_type",
                    "partType",
                    "genre",
                )
            ),
            "authors": cls._normalize_authors(
                cls._first_value(
                    raw,
                    "part_authors",
                    "partAuthors",
                )
            ),
            "year": normalize_space(
                cls._first_value(
                    raw,
                    "part_year",
                    "partYear",
                )
            ),
            "volume": normalize_space(
                cls._first_value(
                    raw,
                    "part_volume",
                    "partVolume",
                )
            ),
            "issue": normalize_space(
                cls._first_value(
                    raw,
                    "part_issue",
                    "partIssue",
                )
            ),
            "start_page": normalize_space(
                cls._first_value(
                    raw,
                    "start_page",
                    "startPage",
                )
            ),
            "end_page": normalize_space(
                cls._first_value(
                    raw,
                    "end_page",
                    "endPage",
                )
            ),
            "doi": normalize_space(
                cls._first_value(raw, "doi")
            ),
        }

    @classmethod
    def _normalize_page(
        cls,
        raw: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Normalize BHL page metadata."""

        return {
            "page_id": normalize_space(
                cls._first_value(raw, "page_id", "pageId")
            ),
            "item_id": normalize_space(
                cls._first_value(raw, "item_id", "itemId")
            ),
            "page_number": normalize_space(
                cls._first_value(
                    raw,
                    "page_number",
                    "pageNumber",
                )
            ),
            "page_type": normalize_space(
                cls._first_value(
                    raw,
                    "page_type",
                    "pageType",
                )
            ),
            "page_sequence": cls._optional_int(
                cls._first_value(
                    raw,
                    "page_sequence",
                    "pageSequence",
                    "sequence",
                )
            ),
            "year": normalize_space(
                cls._first_value(
                    raw,
                    "page_year",
                    "pageYear",
                )
            ),
            "text_url": normalize_space(
                cls._first_value(
                    raw,
                    "text_url",
                    "textUrl",
                )
            ),
            "image_url": normalize_space(
                cls._first_value(
                    raw,
                    "image_url",
                    "imageUrl",
                )
            ),
            "thumbnail_url": normalize_space(
                cls._first_value(
                    raw,
                    "thumbnail_url",
                    "thumbnailUrl",
                )
            ),
        }

    @classmethod
    def _normalize_article(
        cls,
        raw: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Normalize article-style bibliographic metadata."""

        return {
            "title": normalize_space(
                cls._first_value(
                    raw,
                    "article_title",
                    "articleTitle",
                )
            ),
            "journal": normalize_space(
                cls._first_value(
                    raw,
                    "journal",
                    "journal_title",
                    "journalTitle",
                )
            ),
            "volume": normalize_space(
                cls._first_value(
                    raw,
                    "article_volume",
                    "articleVolume",
                )
            ),
            "issue": normalize_space(
                cls._first_value(
                    raw,
                    "article_issue",
                    "articleIssue",
                )
            ),
            "pages": normalize_space(
                cls._first_value(
                    raw,
                    "article_pages",
                    "articlePages",
                    "pages",
                )
            ),
            "year": normalize_space(
                cls._first_value(
                    raw,
                    "article_year",
                    "articleYear",
                )
            ),
            "doi": normalize_space(
                cls._first_value(
                    raw,
                    "article_doi",
                    "articleDoi",
                    "doi",
                )
            ),
            "abstract": normalize_space(
                cls._first_value(
                    raw,
                    "abstract",
                    "article_abstract",
                    "articleAbstract",
                )
            ),
        }

    @classmethod
    def _normalize_name_occurrences(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize taxonomic-name occurrences in BHL pages."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                entry = dict(item)
                entry.update(
                    {
                        "name": normalize_space(
                            cls._first_value(
                                item,
                                "name",
                                "scientific_name",
                                "scientificName",
                                "name_found",
                                "nameFound",
                            )
                        ),
                        "name_id": normalize_space(
                            cls._first_value(
                                item,
                                "name_id",
                                "nameId",
                                "bhl_name_id",
                                "bhlNameId",
                            )
                        ),
                        "page_id": normalize_space(
                            cls._first_value(
                                item,
                                "page_id",
                                "pageId",
                            )
                        ),
                        "context": normalize_space(
                            cls._first_value(
                                item,
                                "context",
                                "snippet",
                            )
                        ),
                        "start_offset": cls._optional_int(
                            cls._first_value(
                                item,
                                "start_offset",
                                "startOffset",
                            )
                        ),
                        "end_offset": cls._optional_int(
                            cls._first_value(
                                item,
                                "end_offset",
                                "endOffset",
                            )
                        ),
                    }
                )

                if entry.get("name"):
                    result.append(entry)
            else:
                name = normalize_space(item)

                if name:
                    result.append(
                        {
                            "name": name,
                            "name_id": "",
                            "page_id": "",
                            "context": "",
                            "start_offset": None,
                            "end_offset": None,
                        }
                    )

        return result

    @classmethod
    def _normalize_authors(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize author and creator records."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                entry = dict(item)
                entry.update(
                    {
                        "name": normalize_space(
                            cls._first_value(
                                item,
                                "name",
                                "full_name",
                                "fullName",
                            )
                        ),
                        "first_name": normalize_space(
                            cls._first_value(
                                item,
                                "first_name",
                                "firstName",
                                "given",
                            )
                        ),
                        "last_name": normalize_space(
                            cls._first_value(
                                item,
                                "last_name",
                                "lastName",
                                "surname",
                            )
                        ),
                        "role": normalize_space(
                            cls._first_value(
                                item,
                                "role",
                                "type",
                            )
                        ),
                        "identifier": normalize_space(
                            cls._first_value(
                                item,
                                "identifier",
                                "id",
                                "orcid",
                            )
                        ),
                    }
                )

                if entry.get("name") or entry.get("last_name"):
                    result.append(entry)
            else:
                name = normalize_space(item)

                if name:
                    result.append(
                        {
                            "name": name,
                            "first_name": "",
                            "last_name": "",
                            "role": "",
                            "identifier": "",
                        }
                    )

        return result

    @classmethod
    def _normalize_subjects(
        cls,
        value: Any,
    ) -> list[dict[str, str]]:
        """Normalize subject and keyword metadata."""

        result: list[dict[str, str]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                name = normalize_space(
                    cls._first_value(
                        item,
                        "name",
                        "subject",
                        "term",
                        "value",
                    )
                )
                vocabulary = normalize_space(
                    cls._first_value(
                        item,
                        "vocabulary",
                        "scheme",
                        "source",
                    )
                )
            else:
                name = normalize_space(item)
                vocabulary = ""

            if name:
                result.append(
                    {
                        "name": name,
                        "vocabulary": vocabulary,
                    }
                )

        return result

    @classmethod
    def _normalize_media(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize BHL images, plates, illustrations, and scans."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                entry = dict(item)
                entry.update(
                    {
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
                                "illustrator",
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
                        "page_id": normalize_space(
                            cls._first_value(
                                item,
                                "page_id",
                                "pageId",
                            )
                        ),
                    }
                )
            else:
                entry = {
                    "url": normalize_space(item),
                    "thumbnail_url": "",
                    "type": "",
                    "title": "",
                    "creator": "",
                    "license": "",
                    "page_id": "",
                }

            if entry.get("url") or entry.get("thumbnail_url"):
                result.append(entry)

        return result

    @classmethod
    def _normalize_identifiers(
        cls,
        value: Any,
        *,
        raw: Mapping[str, Any],
    ) -> list[dict[str, str]]:
        """Normalize BHL and external identifiers."""

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
            "doi": "DOI",
            "issn": "ISSN",
            "isbn": "ISBN",
            "oclc": "OCLC",
            "oclc_number": "OCLC",
            "oclcNumber": "OCLC",
            "lccn": "LCCN",
            "bio_store_id": "BioStor",
            "bioStoreId": "BioStor",
            "wikidata_id": "Wikidata",
            "wikidataId": "Wikidata",
            "gbif_id": "GBIF",
            "gbifId": "GBIF",
            "ipni_id": "IPNI",
            "ipniId": "IPNI",
            "zoobank_lsid": "ZooBank",
            "zoobankLsid": "ZooBank",
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
        """Normalize bibliographic references and citations."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                entry = dict(item)
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
                        "page": normalize_space(
                            cls._first_value(
                                item,
                                "page",
                                "pages",
                            )
                        ),
                    }
                )
                result.append(entry)
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
                            "page": "",
                        }
                    )

        return result

    @staticmethod
    def _normalize_rank(value: Any) -> str:
        """Normalize taxonomic and reference ranks."""

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
            "sub order": "suborder",
            "sub class": "subclass",
            "sub phylum": "subphylum",
            "var.": "variety",
            "forma": "form",
            "f.": "form",
            "no rank": "unranked",
        }

        if not rank:
            return "unknown"

        return aliases.get(
            rank,
            rank.replace(" ", "_"),
        )

    @staticmethod
    def _normalize_status(
        value: Any,
        *,
        taxonomic: bool,
    ) -> str:
        """Normalize BHL name or reference status."""

        status = normalize_space(value).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "valid",
            "current": "accepted",
            "synonym": "synonym",
            "unaccepted": "synonym",
            "misapplied": "misapplied",
            "doubtful": "unknown",
            "unresolved": "unknown",
            "reference": "reference",
            "literature": "reference",
        }

        if status:
            return aliases.get(status, status)

        return "reference" if not taxonomic else "unknown"

    @staticmethod
    def _infer_rank(scientific_name: str) -> str:
        """Infer rank from scientific-name structure."""

        words = normalize_space(scientific_name).split()
        lowered = {word.casefold() for word in words}

        if "subsp." in lowered or "subspecies" in lowered:
            return "subspecies"

        if "var." in lowered or "variety" in lowered:
            return "variety"

        if "f." in lowered or "forma" in lowered:
            return "form"

        if len(words) == 2:
            return "species"

        if len(words) >= 3:
            return "subspecies"

        return "unknown"

    @staticmethod
    def _decode_cursor(cursor: str | None) -> int:
        """Decode a non-negative JSONL offset."""

        if not cursor:
            return 0

        try:
            offset = int(cursor)
        except (TypeError, ValueError) as error:
            raise ProviderError(
                f"Invalid BHL cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "BHL cursor must be non-negative."
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
    def _optional_int(value: Any) -> int | None:
        if value in (None, ""):
            return None

        try:
            return int(value)
        except (TypeError, ValueError):
            return None
