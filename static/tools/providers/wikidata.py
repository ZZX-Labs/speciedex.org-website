#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/wikidata.py

Wikidata taxonomy provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It does not depend on live SPARQL or undocumented API
behavior during the main ingestion workflow.

Each source record is normalized into the shared Taxon contract while the
complete Wikidata entity or export row is preserved under
``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "wikidata",
        "path": "static/data/providers/wikidata/taxa.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "Wikidata",
        "source_url": "https://www.wikidata.org/"
    }

Copyright (c) 2026 ZZX-Laboratories
Licensed under the MIT License.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable, Mapping

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
    """File-backed Wikidata taxonomy provider."""

    PROVIDER_NAME = "wikidata"

    DEFAULT_SOURCE_NAME = "Wikidata"
    DEFAULT_SOURCE_URL = "https://www.wikidata.org/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable Wikidata JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"Wikidata export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"Wikidata path is not a file: {source_path}"
            )

        offset = self._decode_cursor(self.cursor)

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
            for line_number, line in enumerate(handle):
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
                    value = json.loads(stripped)
                except json.JSONDecodeError:
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
        """Resolve the configured Wikidata JSONL source path."""

        configured = normalize_space(
            self.definition.get("path")
        )

        if not configured:
            raise ProviderError(
                "Wikidata provider requires a path."
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
        """Normalize one Wikidata taxon entity or flattened export row."""

        provider_id = self._normalize_qid(
            self._first_value(
                raw,
                "qid",
                "item",
                "entity_id",
                "entityId",
                "wikidata_id",
                "wikidataId",
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
            )
        )

        labels = self._normalize_language_map(
            self._first_value(
                raw,
                "labels",
                "label",
            )
        )

        if not scientific_name:
            scientific_name = (
                labels.get("la", "")
                or labels.get("en", "")
                or next(
                    iter(labels.values()),
                    "",
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
                "taxon_name",
                "taxonName",
            )
        ) or scientific_name

        rank = self._normalize_rank(
            self._first_value(
                raw,
                "rank",
                "taxon_rank",
                "taxonRank",
                "rank_label",
                "rankLabel",
            )
        )

        if rank == "unknown":
            rank = self._infer_rank(canonical_name)

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

        accepted_provider_id = self._normalize_qid(
            self._first_value(
                raw,
                "accepted_taxon_id",
                "acceptedTaxonId",
                "accepted_qid",
                "acceptedQid",
                "correct_taxon",
                "correctTaxon",
                "current_taxon",
                "currentTaxon",
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
                "entity_url",
                "entityUrl",
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
                + "/wiki/"
                + provider_id
            )

        lineage = self._extract_lineage(raw)

        aliases = self._normalize_language_aliases(
            self._first_value(
                raw,
                "aliases",
                "alternative_labels",
                "alternativeLabels",
            )
        )

        synonyms = self._extract_synonyms(
            raw,
            scientific_name=scientific_name,
            canonical_name=canonical_name,
            aliases=aliases,
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
                    "taxon_author",
                    "taxonAuthor",
                    "authority",
                )
            ),
            kingdom=lineage.get("kingdom", ""),
            phylum=lineage.get(
                "phylum",
                lineage.get("division", ""),
            ),
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
                    "revision_timestamp",
                    "revisionTimestamp",
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
                "programme": "wikidata",
                "reference_only": True,
                "qid": provider_id,
                "entity_uri": f"http://www.wikidata.org/entity/{provider_id}",
                "accepted_qid": accepted_provider_id,
                "lineage": lineage,
                "parent": {
                    "id": self._normalize_qid(
                        self._first_value(
                            raw,
                            "parent_taxon_id",
                            "parentTaxonId",
                            "parent_qid",
                            "parentQid",
                            "parent_taxon",
                            "parentTaxon",
                            "parent_id",
                            "parentId",
                        )
                    ),
                    "name": normalize_space(
                        self._first_value(
                            raw,
                            "parent_name",
                            "parentName",
                            "parent_taxon_name",
                            "parentTaxonName",
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
                "labels": labels,
                "descriptions": self._normalize_language_map(
                    self._first_value(
                        raw,
                        "descriptions",
                        "description",
                    )
                ),
                "aliases": aliases,
                "common_names": self._normalize_common_names(
                    self._first_value(
                        raw,
                        "common_names",
                        "commonNames",
                        "vernacular_names",
                        "vernacularNames",
                    ),
                    labels=labels,
                ),
                "wikidata": {
                    "revision_id": normalize_space(
                        self._first_value(
                            raw,
                            "revision_id",
                            "revisionId",
                            "lastrevid",
                        )
                    ),
                    "page_id": normalize_space(
                        self._first_value(
                            raw,
                            "page_id",
                            "pageId",
                        )
                    ),
                    "namespace": normalize_space(
                        self._first_value(
                            raw,
                            "namespace",
                            "ns",
                        )
                    ),
                    "redirect": self._optional_bool(
                        self._first_value(
                            raw,
                            "redirect",
                            "is_redirect",
                            "isRedirect",
                        )
                    ),
                    "sitelinks": self._normalize_sitelinks(
                        self._first_value(
                            raw,
                            "sitelinks",
                            "site_links",
                            "siteLinks",
                        )
                    ),
                },
                "claims": self._normalize_claims(
                    self._first_value(
                        raw,
                        "claims",
                        "statements",
                    )
                ),
                "external_identifiers": self._normalize_external_identifiers(
                    raw
                ),
                "conservation": {
                    "status": normalize_space(
                        self._first_value(
                            raw,
                            "conservation_status",
                            "conservationStatus",
                            "iucn_status",
                            "iucnStatus",
                        )
                    ),
                    "status_id": self._normalize_qid(
                        self._first_value(
                            raw,
                            "conservation_status_id",
                            "conservationStatusId",
                            "iucn_status_id",
                            "iucnStatusId",
                        )
                    ),
                    "cites_appendix": self._list_value(
                        self._first_value(
                            raw,
                            "cites_appendix",
                            "citesAppendix",
                            "cites_listings",
                            "citesListings",
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
                "distribution": {
                    "native_range": self._normalize_places(
                        self._first_value(
                            raw,
                            "native_range",
                            "nativeRange",
                            "native_to",
                            "nativeTo",
                        )
                    ),
                    "introduced_range": self._normalize_places(
                        self._first_value(
                            raw,
                            "introduced_range",
                            "introducedRange",
                            "introduced_to",
                            "introducedTo",
                        )
                    ),
                    "endemic_to": self._normalize_places(
                        self._first_value(
                            raw,
                            "endemic_to",
                            "endemicTo",
                        )
                    ),
                    "locations": self._normalize_places(
                        self._first_value(
                            raw,
                            "locations",
                            "location",
                            "found_in_taxon",
                            "foundInTaxon",
                        )
                    ),
                },
                "biology": {
                    "habitat": self._normalize_entities(
                        self._first_value(
                            raw,
                            "habitat",
                            "habitats",
                        )
                    ),
                    "diet": self._normalize_entities(
                        self._first_value(
                            raw,
                            "diet",
                            "food",
                            "feeds_on",
                            "feedsOn",
                        )
                    ),
                    "host": self._normalize_entities(
                        self._first_value(
                            raw,
                            "host",
                            "hosts",
                        )
                    ),
                    "symbiosis": self._normalize_entities(
                        self._first_value(
                            raw,
                            "symbiosis",
                            "symbionts",
                        )
                    ),
                    "life_cycle": self._normalize_entities(
                        self._first_value(
                            raw,
                            "life_cycle",
                            "lifeCycle",
                        )
                    ),
                },
                "measurements": self._normalize_measurements(
                    self._first_value(
                        raw,
                        "measurements",
                        "measurement",
                    )
                ),
                "media": self._normalize_media(
                    self._first_value(
                        raw,
                        "media",
                        "images",
                        "image",
                    ),
                    raw=raw,
                ),
                "references": self._normalize_references(
                    self._first_value(
                        raw,
                        "references",
                        "reference",
                        "sources",
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
        """Extract taxonomic lineage from direct fields or ranked ancestors."""

        lineage = {
            "domain": normalize_space(raw.get("domain")),
            "kingdom": normalize_space(raw.get("kingdom")),
            "phylum": normalize_space(raw.get("phylum")),
            "division": normalize_space(raw.get("division")),
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
            "ancestors",
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
                    "rank_label",
                    "rankLabel",
                    "taxon_rank",
                    "taxonRank",
                )
            )

            name = normalize_space(
                cls._first_value(
                    item,
                    "name",
                    "label",
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
        aliases: Mapping[str, list[str]],
    ) -> list[str]:
        """Extract and deduplicate scientific synonyms and aliases."""

        values = cls._list_value(
            cls._first_value(
                raw,
                "synonyms",
                "synonym",
                "taxonomic_synonyms",
                "taxonomicSynonyms",
                "alternative_scientific_names",
                "alternativeScientificNames",
            )
        )

        for language, language_aliases in aliases.items():
            if language in {"la", "mul"}:
                values.extend(language_aliases)

        excluded = {
            scientific_name.casefold(),
            canonical_name.casefold(),
        }

        result: list[str] = []
        seen: set[str] = set(excluded)

        for item in values:
            if isinstance(item, Mapping):
                normalized = normalize_space(
                    cls._first_value(
                        item,
                        "scientific_name",
                        "scientificName",
                        "name",
                        "value",
                    )
                )
            else:
                normalized = normalize_space(item)

            key = normalized.casefold()

            if not normalized or key in seen:
                continue

            seen.add(key)
            result.append(normalized)

        return result

    @classmethod
    def _normalize_language_map(
        cls,
        value: Any,
    ) -> dict[str, str]:
        """Normalize Wikidata labels or descriptions by language."""

        result: dict[str, str] = {}

        if isinstance(value, Mapping):
            for language, item in value.items():
                if isinstance(item, Mapping):
                    text = normalize_space(
                        cls._first_value(
                            item,
                            "value",
                            "text",
                            "label",
                        )
                    )
                else:
                    text = normalize_space(item)

                if text:
                    result[normalize_space(language)] = text

        elif value is not None:
            text = normalize_space(value)

            if text:
                result["und"] = text

        return result

    @classmethod
    def _normalize_language_aliases(
        cls,
        value: Any,
    ) -> dict[str, list[str]]:
        """Normalize Wikidata aliases grouped by language."""

        result: dict[str, list[str]] = {}

        if not isinstance(value, Mapping):
            return result

        for language, items in value.items():
            normalized_items: list[str] = []
            seen: set[str] = set()

            for item in cls._list_value(items):
                if isinstance(item, Mapping):
                    text = normalize_space(
                        cls._first_value(
                            item,
                            "value",
                            "text",
                            "label",
                        )
                    )
                else:
                    text = normalize_space(item)

                key = text.casefold()

                if not text or key in seen:
                    continue

                seen.add(key)
                normalized_items.append(text)

            if normalized_items:
                result[normalize_space(language)] = normalized_items

        return result

    @classmethod
    def _normalize_common_names(
        cls,
        value: Any,
        *,
        labels: Mapping[str, str],
    ) -> list[dict[str, Any]]:
        """Normalize common names with language metadata."""

        values = cls._list_value(value)

        for language, label in labels.items():
            if language not in {"la", "mul"}:
                values.append(
                    {
                        "name": label,
                        "language": language,
                        "preferred": True,
                    }
                )

        result: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()

        for item in values:
            if isinstance(item, Mapping):
                name = normalize_space(
                    cls._first_value(
                        item,
                        "name",
                        "value",
                        "label",
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
                preferred = cls._optional_bool(
                    cls._first_value(
                        item,
                        "preferred",
                        "is_preferred",
                        "isPreferred",
                    )
                )
                raw = dict(item)
            else:
                name = normalize_space(item)
                language = ""
                preferred = None
                raw = item

            key = (
                name.casefold(),
                language.casefold(),
            )

            if not name or key in seen:
                continue

            seen.add(key)
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
    def _normalize_claims(
        cls,
        value: Any,
    ) -> dict[str, list[dict[str, Any]]]:
        """Normalize Wikidata claims while preserving ranks and qualifiers."""

        result: dict[str, list[dict[str, Any]]] = {}

        if not isinstance(value, Mapping):
            return result

        for property_id, statements in value.items():
            normalized_statements: list[dict[str, Any]] = []

            for statement in cls._list_value(statements):
                if not isinstance(statement, Mapping):
                    continue

                normalized_statements.append(
                    {
                        "id": normalize_space(
                            cls._first_value(
                                statement,
                                "id",
                                "statement_id",
                                "statementId",
                            )
                        ),
                        "rank": normalize_space(
                            cls._first_value(
                                statement,
                                "rank",
                            )
                        ) or "normal",
                        "value": cls._extract_claim_value(statement),
                        "qualifiers": cls._normalize_qualifiers(
                            statement.get("qualifiers")
                        ),
                        "references": cls._normalize_references(
                            statement.get("references")
                        ),
                        "raw": dict(statement),
                    }
                )

            if normalized_statements:
                result[normalize_space(property_id)] = normalized_statements

        return result

    @classmethod
    def _extract_claim_value(
        cls,
        statement: Mapping[str, Any],
    ) -> Any:
        """Extract a useful claim value from flattened or raw entities."""

        direct = cls._first_value(
            statement,
            "value",
            "datavalue",
            "target",
        )

        if direct is not None:
            if isinstance(direct, Mapping):
                nested = cls._first_value(
                    direct,
                    "value",
                    "id",
                    "numeric-id",
                    "text",
                    "amount",
                    "time",
                )

                if nested is not None:
                    return nested

            return direct

        mainsnak = statement.get("mainsnak")

        if isinstance(mainsnak, Mapping):
            datavalue = mainsnak.get("datavalue")

            if isinstance(datavalue, Mapping):
                return datavalue.get("value")

        return None

    @classmethod
    def _normalize_qualifiers(
        cls,
        value: Any,
    ) -> dict[str, list[Any]]:
        """Normalize statement qualifiers by property identifier."""

        result: dict[str, list[Any]] = {}

        if not isinstance(value, Mapping):
            return result

        for property_id, qualifiers in value.items():
            normalized: list[Any] = []

            for qualifier in cls._list_value(qualifiers):
                if isinstance(qualifier, Mapping):
                    datavalue = qualifier.get("datavalue")

                    if isinstance(datavalue, Mapping):
                        normalized.append(datavalue.get("value"))
                    else:
                        normalized.append(
                            cls._first_value(
                                qualifier,
                                "value",
                                "target",
                            )
                        )
                else:
                    normalized.append(qualifier)

            result[normalize_space(property_id)] = normalized

        return result

    @classmethod
    def _normalize_sitelinks(
        cls,
        value: Any,
    ) -> dict[str, dict[str, Any]]:
        """Normalize Wikidata sitelinks."""

        result: dict[str, dict[str, Any]] = {}

        if not isinstance(value, Mapping):
            return result

        for site, item in value.items():
            if isinstance(item, Mapping):
                title = normalize_space(
                    cls._first_value(
                        item,
                        "title",
                        "name",
                    )
                )
                badges = [
                    cls._normalize_qid(entry)
                    for entry in cls._list_value(
                        item.get("badges")
                    )
                    if cls._normalize_qid(entry)
                ]
            else:
                title = normalize_space(item)
                badges = []

            if title:
                result[normalize_space(site)] = {
                    "title": title,
                    "badges": badges,
                }

        return result

    @classmethod
    def _normalize_external_identifiers(
        cls,
        raw: Mapping[str, Any],
    ) -> list[dict[str, str]]:
        """Normalize common external taxonomic identifiers."""

        direct = cls._first_value(
            raw,
            "external_identifiers",
            "externalIdentifiers",
            "identifiers",
        )

        result: list[dict[str, str]] = []

        for item in cls._list_value(direct):
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
            "gbif_id": "GBIF",
            "gbifId": "GBIF",
            "itis_tsn": "ITIS",
            "itisTsn": "ITIS",
            "ncbi_taxid": "NCBI Taxonomy",
            "ncbiTaxid": "NCBI Taxonomy",
            "worms_id": "WoRMS",
            "wormsId": "WoRMS",
            "eol_id": "Encyclopedia of Life",
            "eolId": "Encyclopedia of Life",
            "ipni_id": "IPNI",
            "ipniId": "IPNI",
            "iucn_id": "IUCN",
            "iucnId": "IUCN",
            "bold_id": "BOLD",
            "boldId": "BOLD",
            "catalogue_of_life_id": "Catalogue of Life",
            "catalogueOfLifeId": "Catalogue of Life",
            "taxref_id": "TAXREF",
            "taxrefId": "TAXREF",
            "fishbase_id": "FishBase",
            "fishbaseId": "FishBase",
            "mycobank_id": "MycoBank",
            "mycobankId": "MycoBank",
        }

        seen = {
            (
                item["source"].casefold(),
                item["identifier"].casefold(),
            )
            for item in result
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
    def _normalize_entities(
        cls,
        value: Any,
    ) -> list[dict[str, str]]:
        """Normalize entity references."""

        result: list[dict[str, str]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                qid = cls._normalize_qid(
                    cls._first_value(
                        item,
                        "qid",
                        "id",
                        "entity_id",
                        "entityId",
                    )
                )
                label = normalize_space(
                    cls._first_value(
                        item,
                        "label",
                        "name",
                        "value",
                    )
                )
            else:
                qid = cls._normalize_qid(item)
                label = "" if qid else normalize_space(item)

            if qid or label:
                result.append(
                    {
                        "qid": qid,
                        "label": label,
                    }
                )

        return result

    @classmethod
    def _normalize_places(
        cls,
        value: Any,
    ) -> list[dict[str, str]]:
        """Normalize geographic entity references."""

        return cls._normalize_entities(value)

    @classmethod
    def _normalize_measurements(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize quantity and measurement statements."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if not isinstance(item, Mapping):
                continue

            result.append(
                {
                    "property": normalize_space(
                        cls._first_value(
                            item,
                            "property",
                            "predicate",
                            "name",
                        )
                    ),
                    "amount": cls._optional_float(
                        cls._first_value(
                            item,
                            "amount",
                            "value",
                        )
                    ),
                    "unit": normalize_space(
                        cls._first_value(
                            item,
                            "unit",
                            "unit_label",
                            "unitLabel",
                        )
                    ),
                    "lower_bound": cls._optional_float(
                        cls._first_value(
                            item,
                            "lower_bound",
                            "lowerBound",
                        )
                    ),
                    "upper_bound": cls._optional_float(
                        cls._first_value(
                            item,
                            "upper_bound",
                            "upperBound",
                        )
                    ),
                    "raw": dict(item),
                }
            )

        return result

    @classmethod
    def _normalize_media(
        cls,
        value: Any,
        *,
        raw: Mapping[str, Any],
    ) -> list[dict[str, Any]]:
        """Normalize Commons images, audio, video, and distribution maps."""

        values = cls._list_value(value)

        for key, media_type in (
            ("image", "image"),
            ("image_url", "image"),
            ("imageUrl", "image"),
            ("taxon_image", "image"),
            ("taxonImage", "image"),
            ("range_map", "map"),
            ("rangeMap", "map"),
            ("audio", "audio"),
            ("video", "video"),
        ):
            media_value = raw.get(key)

            if media_value not in (None, "", [], {}):
                values.append(
                    {
                        "value": media_value,
                        "type": media_type,
                    }
                )

        result: list[dict[str, Any]] = []

        for item in values:
            if isinstance(item, Mapping):
                filename = normalize_space(
                    cls._first_value(
                        item,
                        "filename",
                        "file",
                        "title",
                        "value",
                    )
                )
                url = normalize_space(
                    cls._first_value(
                        item,
                        "url",
                        "media_url",
                        "mediaUrl",
                    )
                )
                media_type = normalize_space(
                    cls._first_value(
                        item,
                        "type",
                        "media_type",
                        "mediaType",
                    )
                ).casefold()
                creator = normalize_space(
                    cls._first_value(
                        item,
                        "creator",
                        "author",
                    )
                )
                license_name = normalize_space(
                    cls._first_value(
                        item,
                        "license",
                        "rights",
                    )
                )
                raw_item = dict(item)
            else:
                filename = normalize_space(item)
                url = ""
                media_type = ""
                creator = ""
                license_name = ""
                raw_item = item

            if filename or url:
                result.append(
                    {
                        "filename": filename,
                        "url": url,
                        "type": media_type,
                        "creator": creator,
                        "license": license_name,
                        "raw": raw_item,
                    }
                )

        return result

    @classmethod
    def _normalize_references(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize statement and entity references."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                snaks = item.get("snaks")

                result.append(
                    {
                        "hash": normalize_space(
                            cls._first_value(
                                item,
                                "hash",
                                "id",
                            )
                        ),
                        "stated_in": cls._normalize_entities(
                            cls._first_value(
                                item,
                                "stated_in",
                                "statedIn",
                                "source",
                            )
                        ),
                        "reference_url": normalize_space(
                            cls._first_value(
                                item,
                                "reference_url",
                                "referenceUrl",
                                "url",
                            )
                        ),
                        "title": normalize_space(
                            cls._first_value(
                                item,
                                "title",
                                "citation",
                            )
                        ),
                        "retrieved": normalize_space(
                            cls._first_value(
                                item,
                                "retrieved",
                                "retrieved_at",
                                "retrievedAt",
                            )
                        ),
                        "doi": normalize_space(
                            cls._first_value(
                                item,
                                "doi",
                            )
                        ),
                        "snaks": snaks if isinstance(snaks, Mapping) else {},
                        "raw": dict(item),
                    }
                )
            else:
                citation = normalize_space(item)

                if citation:
                    result.append(
                        {
                            "hash": "",
                            "stated_in": [],
                            "reference_url": "",
                            "title": citation,
                            "retrieved": "",
                            "doi": "",
                            "snaks": {},
                            "raw": item,
                        }
                    )

        return result

    @staticmethod
    def _normalize_qid(value: Any) -> str:
        """Normalize a Wikidata entity identifier."""

        if isinstance(value, Mapping):
            value = Provider._first_value(
                value,
                "id",
                "qid",
                "value",
                "entity_id",
                "entityId",
            )

        normalized = normalize_space(value)

        if not normalized:
            return ""

        if "/entity/" in normalized:
            normalized = normalized.rsplit("/", 1)[-1]

        if "/wiki/" in normalized:
            normalized = normalized.rsplit("/", 1)[-1]

        normalized = normalized.upper()

        if normalized.startswith("Q") and normalized[1:].isdigit():
            return normalized

        return normalized

    @staticmethod
    def _normalize_rank(value: Any) -> str:
        """Normalize Wikidata and biological rank labels."""

        if isinstance(value, Mapping):
            value = Provider._first_value(
                value,
                "label",
                "name",
                "value",
                "id",
            )

        rank = normalize_space(value).casefold().replace(
            "_",
            " ",
        ).replace(
            "-",
            " ",
        )

        aliases = {
            "taxon": "unranked",
            "no rank": "unranked",
            "clade": "clade",
            "division": "phylum",
            "sub division": "subphylum",
            "super kingdom": "domain",
            "superkingdom": "domain",
            "sub species": "subspecies",
            "sub genus": "subgenus",
            "sub family": "subfamily",
            "sub order": "suborder",
            "sub class": "subclass",
            "sub phylum": "subphylum",
            "var.": "variety",
            "forma": "form",
            "f.": "form",
        }

        if not rank:
            return "unknown"

        return aliases.get(
            rank,
            rank.replace(" ", "_"),
        )

    @staticmethod
    def _normalize_status(value: Any) -> str:
        """Normalize Wikidata taxonomic or name status labels."""

        status = normalize_space(value).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "valid",
            "correct": "accepted",
            "synonym": "synonym",
            "taxonomic synonym": "synonym",
            "basionym": "reference",
            "misapplied": "misapplied",
            "nom. illeg.": "excluded",
            "illegitimate": "excluded",
            "invalid": "excluded",
            "deprecated": "inactive",
            "obsolete": "inactive",
            "uncertain": "unknown",
            "unresolved": "unknown",
            "reference": "reference",
        }

        return aliases.get(
            status,
            status or "reference",
        )

    @staticmethod
    def _infer_rank(scientific_name: str) -> str:
        """Infer biological rank from name structure."""

        words = normalize_space(scientific_name).split()

        lowered = {
            word.casefold()
            for word in words
        }

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
        """Decode a non-negative JSONL line offset."""

        if not cursor:
            return 0

        try:
            offset = int(cursor)
        except (TypeError, ValueError) as error:
            raise ProviderError(
                f"Invalid Wikidata cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "Wikidata cursor must be non-negative."
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
    def _optional_float(value: Any) -> float | None:
        if value in (None, ""):
            return None

        if isinstance(value, Mapping):
            value = Provider._first_value(
                value,
                "amount",
                "value",
            )

        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _optional_bool(value: Any) -> bool | None:
        if isinstance(value, bool):
            return value

        if isinstance(value, int):
            return bool(value)

        normalized = normalize_space(value).casefold()

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
