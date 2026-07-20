#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/openalex.py

OpenAlex scholarly-graph provider plug-in.

This provider queries the OpenAlex REST API and converts scholarly works into
reference-oriented Speciedex records. OpenAlex is not a taxonomic authority.
Its role is to enrich Speciedex taxa with literature, citations, authors,
institutions, journals, publishers, concepts, topics, funders, grants,
open-access metadata, identifiers, related works, and taxonomic-name mentions.

The complete OpenAlex work object is preserved under ``Taxon.extra["raw"]``.

Recommended providers.json configuration:

    {
        "name": "openalex",
        "module": "openalex",
        "enabled": true,
        "base_url": "https://api.openalex.org",
        "endpoint": "/works",
        "mailto": "research@example.org",
        "filter": "from_publication_date:2000-01-01",
        "select": "",
        "sort": "id:asc",
        "batch_size": 200,
        "extract_taxonomic_mentions": true
    }

Optional filters may be supplied either as a complete OpenAlex ``filter``
string or with convenience keys such as:

    {
        "search": "biodiversity",
        "from_publication_date": "2020-01-01",
        "to_publication_date": "2026-12-31",
        "type": "article",
        "open_access": "is_oa:true",
        "has_doi": true
    }

The cursor is the opaque OpenAlex cursor returned by ``meta.next_cursor``.
The initial cursor is ``*``.

Copyright (c) 2026 ZZX-Laboratories
Licensed under the MIT License.
"""

from __future__ import annotations

import re
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


_BINOMIAL_RE = re.compile(
    r"\b([A-Z][a-z]{2,})\s+([a-z][a-z-]{2,})\b"
)

_INFRASPECIFIC_RE = re.compile(
    r"\b([A-Z][a-z]{2,})\s+([a-z][a-z-]{2,})\s+"
    r"(?:(subsp|ssp|var|forma|f)\.?\s+)?([a-z][a-z-]{2,})\b"
)

_EXCLUDED_SECOND_WORDS = {
    "article",
    "author",
    "based",
    "between",
    "case",
    "data",
    "dataset",
    "effect",
    "effects",
    "evidence",
    "global",
    "group",
    "human",
    "impact",
    "model",
    "models",
    "network",
    "novel",
    "paper",
    "population",
    "review",
    "species",
    "study",
    "system",
    "using",
}


class Provider(BaseProvider):
    """HTTP-backed OpenAlex works provider."""

    PROVIDER_NAME = "openalex"

    DEFAULT_BASE_URL = "https://api.openalex.org"
    DEFAULT_ENDPOINT = "/works"

    def fetch(self) -> Batch:
        """Fetch and normalize one OpenAlex cursor page."""

        base_url = normalize_space(
            self.definition.get("base_url")
            or self.DEFAULT_BASE_URL
        ).rstrip("/")

        endpoint = normalize_space(
            self.definition.get("endpoint")
            or self.DEFAULT_ENDPOINT
        )

        if not endpoint.startswith("/"):
            endpoint = "/" + endpoint

        cursor = normalize_space(self.cursor) or "*"
        per_page = min(
            max(
                1,
                safe_int(
                    self.definition.get(
                        "per_page",
                        self.batch_size,
                    ),
                    self.batch_size,
                ),
            ),
            200,
        )

        params = self._build_params(
            cursor=cursor,
            per_page=per_page,
        )

        payload = self.http.get_json(
            f"{base_url}{endpoint}",
            params,
        )

        if not isinstance(payload, Mapping):
            raise ProviderError(
                "OpenAlex returned a non-object response."
            )

        rows = payload.get("results", [])

        if not isinstance(rows, list):
            raise ProviderError(
                "OpenAlex response has no valid results list."
            )

        retrieved_at = now()
        records: list[Taxon] = []

        for item in rows:
            if not isinstance(item, Mapping):
                continue

            record = self._normalize_work(
                dict(item),
                retrieved_at=retrieved_at,
            )

            if record is not None:
                records.append(record)

        meta = payload.get("meta", {})
        next_cursor = ""

        if isinstance(meta, Mapping):
            next_cursor = normalize_space(
                meta.get("next_cursor")
            )

        exhausted = not rows or not next_cursor

        return Batch(
            records=records,
            next_cursor=None if exhausted else next_cursor,
            exhausted=exhausted,
            requests=1,
            raw=len(rows),
        )

    def _build_params(
        self,
        *,
        cursor: str,
        per_page: int,
    ) -> dict[str, Any]:
        """Build OpenAlex query parameters from provider configuration."""

        params: dict[str, Any] = {
            "cursor": cursor,
            "per-page": per_page,
        }

        mailto = normalize_space(
            self.definition.get("mailto")
            or self.definition.get("email")
        )

        if mailto:
            params["mailto"] = mailto

        search = normalize_space(
            self.definition.get("search")
        )

        if search:
            params["search"] = search

        select = normalize_space(
            self.definition.get("select")
        )

        if select:
            params["select"] = select

        sort = normalize_space(
            self.definition.get("sort")
            or "id:asc"
        )

        if sort:
            params["sort"] = sort

        sample = safe_int(
            self.definition.get("sample"),
            0,
        )

        if sample > 0:
            params["sample"] = sample

        seed = safe_int(
            self.definition.get("seed"),
            0,
        )

        if seed > 0:
            params["seed"] = seed

        filter_value = self._build_filter()

        if filter_value:
            params["filter"] = filter_value

        return params

    def _build_filter(self) -> str:
        """Build an OpenAlex filter expression."""

        configured = normalize_space(
            self.definition.get("filter")
        )

        parts: list[str] = []

        if configured:
            parts.append(configured.strip(","))

        simple_filters = {
            "from_publication_date": "from_publication_date",
            "to_publication_date": "to_publication_date",
            "publication_year": "publication_year",
            "type": "type",
            "language": "language",
            "doi": "doi",
            "openalex": "openalex",
            "pmid": "pmid",
            "pmcid": "pmcid",
            "mag": "mag",
            "host_venue_id": "primary_location.source.id",
            "institution_id": "authorships.institutions.id",
            "author_id": "authorships.author.id",
            "concept_id": "concepts.id",
            "topic_id": "topics.id",
            "funder_id": "grants.funder",
        }

        for config_key, openalex_key in simple_filters.items():
            value = normalize_space(
                self.definition.get(config_key)
            )

            if value:
                parts.append(f"{openalex_key}:{value}")

        boolean_filters = {
            "has_doi": "has_doi",
            "has_abstract": "has_abstract",
            "has_fulltext": "has_fulltext",
            "has_pdf_url": "has_pdf_url",
            "is_oa": "is_oa",
            "is_retracted": "is_retracted",
            "is_paratext": "is_paratext",
        }

        for config_key, openalex_key in boolean_filters.items():
            value = self.definition.get(config_key)

            if isinstance(value, bool):
                parts.append(
                    f"{openalex_key}:{str(value).lower()}"
                )

        open_access = normalize_space(
            self.definition.get("open_access")
        )

        if open_access:
            parts.append(open_access)

        return ",".join(
            part
            for part in parts
            if part
        )

    def _normalize_work(
        self,
        raw: dict[str, Any],
        *,
        retrieved_at: str,
    ) -> Taxon | None:
        """Normalize one OpenAlex work into a reference record."""

        openalex_id = normalize_space(
            self._first_value(
                raw,
                "id",
                "openalex_id",
                "openalexId",
            )
        )

        provider_id = self._short_openalex_id(openalex_id)

        title = normalize_space(
            self._first_value(
                raw,
                "display_name",
                "displayName",
                "title",
            )
        )

        if not provider_id or not title:
            return None

        abstract = self._reconstruct_abstract(
            raw.get("abstract_inverted_index")
        )

        mentions = self._extract_taxonomic_mentions(
            title=title,
            abstract=abstract,
            raw=raw,
        )

        primary_mention = (
            mentions[0]["scientific_name"]
            if mentions
            else title
        )

        source_url = normalize_space(
            self._first_value(
                raw,
                "id",
                "landing_page_url",
                "landingPageUrl",
            )
        )

        doi = normalize_space(raw.get("doi"))

        if doi and doi.startswith("https://doi.org/"):
            doi_value = doi.removeprefix("https://doi.org/")
        else:
            doi_value = doi

        publication_date = normalize_space(
            raw.get("publication_date")
        )

        publication_year = self._optional_int(
            raw.get("publication_year")
        )

        authorships = self._normalize_authorships(
            raw.get("authorships")
        )

        author_line = "; ".join(
            entry["author"]["display_name"]
            for entry in authorships
            if entry["author"]["display_name"]
        )

        primary_location = self._normalize_location(
            raw.get("primary_location")
        )

        locations = self._normalize_locations(
            raw.get("locations")
        )

        best_oa_location = self._normalize_location(
            raw.get("best_oa_location")
        )

        open_access = self._normalize_open_access(
            raw.get("open_access")
        )

        identifiers = self._normalize_identifiers(
            raw.get("ids"),
            raw=raw,
        )

        related_work_ids = self._normalize_id_list(
            raw.get("related_works")
        )

        referenced_work_ids = self._normalize_id_list(
            raw.get("referenced_works")
        )

        return Taxon(
            provider=self.name,
            provider_id=provider_id,
            scientific_name=primary_mention,
            canonical_name=primary_mention,
            rank=(
                self._infer_taxonomic_rank(primary_mention)
                if mentions
                else "publication"
            ),
            status="reference",
            authorship=author_line,
            kingdom="",
            phylum="",
            class_name="",
            order="",
            family="",
            genus=self._infer_genus(primary_mention),
            accepted_provider_id="",
            source_url=source_url,
            source_modified=normalize_space(
                raw.get("updated_date")
            ),
            retrieved_at=retrieved_at,
            synonyms=[],
            extra={
                "source": "OpenAlex",
                "programme": "openalex",
                "reference_only": True,
                "entity_type": "scholarly_work",
                "openalex_id": provider_id,
                "title": title,
                "display_name": title,
                "abstract": abstract,
                "publication": {
                    "type": normalize_space(
                        raw.get("type")
                    ),
                    "type_crossref": normalize_space(
                        raw.get("type_crossref")
                    ),
                    "publication_year": publication_year,
                    "publication_date": publication_date,
                    "language": normalize_space(
                        raw.get("language")
                    ),
                    "doi": doi_value,
                    "is_paratext": self._optional_bool(
                        raw.get("is_paratext")
                    ),
                    "is_retracted": self._optional_bool(
                        raw.get("is_retracted")
                    ),
                },
                "bibliographic": {
                    "volume": normalize_space(
                        self._nested_value(
                            raw,
                            "biblio",
                            "volume",
                        )
                    ),
                    "issue": normalize_space(
                        self._nested_value(
                            raw,
                            "biblio",
                            "issue",
                        )
                    ),
                    "first_page": normalize_space(
                        self._nested_value(
                            raw,
                            "biblio",
                            "first_page",
                        )
                    ),
                    "last_page": normalize_space(
                        self._nested_value(
                            raw,
                            "biblio",
                            "last_page",
                        )
                    ),
                },
                "authorships": authorships,
                "institutions": self._collect_institutions(
                    authorships
                ),
                "countries_distinct_count": self._optional_int(
                    raw.get("countries_distinct_count")
                ),
                "institutions_distinct_count": self._optional_int(
                    raw.get("institutions_distinct_count")
                ),
                "corresponding_author_ids": self._normalize_id_list(
                    raw.get("corresponding_author_ids")
                ),
                "corresponding_institution_ids": self._normalize_id_list(
                    raw.get("corresponding_institution_ids")
                ),
                "primary_location": primary_location,
                "best_oa_location": best_oa_location,
                "locations": locations,
                "locations_count": self._optional_int(
                    raw.get("locations_count")
                ),
                "open_access": open_access,
                "has_fulltext": self._optional_bool(
                    raw.get("has_fulltext")
                ),
                "fulltext_origin": normalize_space(
                    raw.get("fulltext_origin")
                ),
                "fulltext_search": self._normalize_fulltext(
                    raw.get("fulltext_search")
                ),
                "concepts": self._normalize_concepts(
                    raw.get("concepts")
                ),
                "topics": self._normalize_topics(
                    raw.get("topics")
                ),
                "primary_topic": self._normalize_topic(
                    raw.get("primary_topic")
                ),
                "keywords": self._normalize_keywords(
                    raw.get("keywords")
                ),
                "sustainable_development_goals": self._normalize_sdgs(
                    raw.get("sustainable_development_goals")
                ),
                "grants": self._normalize_grants(
                    raw.get("grants")
                ),
                "funders": self._normalize_funders(
                    raw.get("funders")
                ),
                "mesh": self._normalize_mesh(
                    raw.get("mesh")
                ),
                "citation": {
                    "cited_by_count": self._optional_int(
                        raw.get("cited_by_count")
                    ),
                    "referenced_works_count": self._optional_int(
                        raw.get("referenced_works_count")
                    ),
                    "referenced_works": referenced_work_ids,
                    "related_works": related_work_ids,
                    "counts_by_year": self._normalize_counts_by_year(
                        raw.get("counts_by_year")
                    ),
                    "citation_normalized_percentile": (
                        self._normalize_mapping(
                            raw.get(
                                "citation_normalized_percentile"
                            )
                        )
                    ),
                    "cited_by_percentile_year": (
                        self._normalize_mapping(
                            raw.get("cited_by_percentile_year")
                        )
                    ),
                    "fwci": self._optional_float(
                        raw.get("fwci")
                    ),
                },
                "identifiers": identifiers,
                "taxonomic_mentions": mentions,
                "apc": self._normalize_apc(
                    raw.get("apc_list")
                ),
                "datasets": self._normalize_datasets(
                    self._first_value(
                        raw,
                        "datasets",
                        "supplementary_material",
                        "supplementaryMaterial",
                    )
                ),
                "versions": self._normalize_versions(
                    raw.get("versions")
                ),
                "created_date": normalize_space(
                    raw.get("created_date")
                ),
                "updated_date": normalize_space(
                    raw.get("updated_date")
                ),
                "raw": raw,
            },
        )

    @classmethod
    def _normalize_authorships(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize authors, institutions, countries, and ORCIDs."""

        result: list[dict[str, Any]] = []

        for position, item in enumerate(cls._list_value(value)):
            if not isinstance(item, Mapping):
                continue

            author = item.get("author", {})
            author = (
                author
                if isinstance(author, Mapping)
                else {}
            )

            institutions = cls._normalize_institutions(
                item.get("institutions")
            )

            result.append(
                {
                    "position": normalize_space(
                        item.get("author_position")
                    ) or str(position + 1),
                    "is_corresponding": cls._optional_bool(
                        item.get("is_corresponding")
                    ),
                    "author": {
                        "id": cls._short_openalex_id(
                            normalize_space(author.get("id"))
                        ),
                        "display_name": normalize_space(
                            author.get("display_name")
                        ),
                        "orcid": cls._clean_orcid(
                            normalize_space(author.get("orcid"))
                        ),
                    },
                    "institutions": institutions,
                    "countries": [
                        normalize_space(country)
                        for country in cls._list_value(
                            item.get("countries")
                        )
                        if normalize_space(country)
                    ],
                    "raw_affiliation_strings": [
                        normalize_space(text)
                        for text in cls._list_value(
                            item.get(
                                "raw_affiliation_strings"
                            )
                        )
                        if normalize_space(text)
                    ],
                }
            )

        return result

    @classmethod
    def _normalize_institutions(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if not isinstance(item, Mapping):
                continue

            result.append(
                {
                    "id": cls._short_openalex_id(
                        normalize_space(item.get("id"))
                    ),
                    "display_name": normalize_space(
                        item.get("display_name")
                    ),
                    "ror": normalize_space(item.get("ror")),
                    "country_code": normalize_space(
                        item.get("country_code")
                    ),
                    "type": normalize_space(
                        item.get("type")
                    ),
                    "lineage": cls._normalize_id_list(
                        item.get("lineage")
                    ),
                }
            )

        return result

    @classmethod
    def _collect_institutions(
        cls,
        authorships: Iterable[Mapping[str, Any]],
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        seen: set[str] = set()

        for authorship in authorships:
            for institution in cls._list_value(
                authorship.get("institutions")
            ):
                if not isinstance(institution, Mapping):
                    continue

                key = normalize_space(
                    institution.get("id")
                    or institution.get("ror")
                    or institution.get("display_name")
                ).casefold()

                if not key or key in seen:
                    continue

                seen.add(key)
                result.append(dict(institution))

        return result

    @classmethod
    def _normalize_location(
        cls,
        value: Any,
    ) -> dict[str, Any]:
        if not isinstance(value, Mapping):
            return {}

        source = value.get("source", {})
        source = (
            source
            if isinstance(source, Mapping)
            else {}
        )

        return {
            "is_oa": cls._optional_bool(
                value.get("is_oa")
            ),
            "landing_page_url": normalize_space(
                value.get("landing_page_url")
            ),
            "pdf_url": normalize_space(
                value.get("pdf_url")
            ),
            "license": normalize_space(
                value.get("license")
            ),
            "license_id": normalize_space(
                value.get("license_id")
            ),
            "version": normalize_space(
                value.get("version")
            ),
            "is_accepted": cls._optional_bool(
                value.get("is_accepted")
            ),
            "is_published": cls._optional_bool(
                value.get("is_published")
            ),
            "source": {
                "id": cls._short_openalex_id(
                    normalize_space(source.get("id"))
                ),
                "display_name": normalize_space(
                    source.get("display_name")
                ),
                "issn_l": normalize_space(
                    source.get("issn_l")
                ),
                "issn": [
                    normalize_space(item)
                    for item in cls._list_value(
                        source.get("issn")
                    )
                    if normalize_space(item)
                ],
                "is_oa": cls._optional_bool(
                    source.get("is_oa")
                ),
                "is_in_doaj": cls._optional_bool(
                    source.get("is_in_doaj")
                ),
                "is_core": cls._optional_bool(
                    source.get("is_core")
                ),
                "host_organization": cls._short_openalex_id(
                    normalize_space(
                        source.get("host_organization")
                    )
                ),
                "host_organization_name": normalize_space(
                    source.get(
                        "host_organization_name"
                    )
                ),
                "type": normalize_space(
                    source.get("type")
                ),
            },
        }

    @classmethod
    def _normalize_locations(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        return [
            location
            for location in (
                cls._normalize_location(item)
                for item in cls._list_value(value)
            )
            if location
        ]

    @classmethod
    def _normalize_open_access(
        cls,
        value: Any,
    ) -> dict[str, Any]:
        if not isinstance(value, Mapping):
            return {}

        return {
            "is_oa": cls._optional_bool(
                value.get("is_oa")
            ),
            "oa_status": normalize_space(
                value.get("oa_status")
            ),
            "oa_url": normalize_space(
                value.get("oa_url")
            ),
            "any_repository_has_fulltext": cls._optional_bool(
                value.get(
                    "any_repository_has_fulltext"
                )
            ),
        }

    @classmethod
    def _normalize_concepts(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if not isinstance(item, Mapping):
                continue

            result.append(
                {
                    "id": cls._short_openalex_id(
                        normalize_space(item.get("id"))
                    ),
                    "display_name": normalize_space(
                        item.get("display_name")
                    ),
                    "level": cls._optional_int(
                        item.get("level")
                    ),
                    "score": cls._optional_float(
                        item.get("score")
                    ),
                    "wikidata": normalize_space(
                        item.get("wikidata")
                    ),
                }
            )

        return result

    @classmethod
    def _normalize_topic(
        cls,
        value: Any,
    ) -> dict[str, Any]:
        if not isinstance(value, Mapping):
            return {}

        field = value.get("field", {})
        subfield = value.get("subfield", {})
        domain = value.get("domain", {})

        return {
            "id": cls._short_openalex_id(
                normalize_space(value.get("id"))
            ),
            "display_name": normalize_space(
                value.get("display_name")
            ),
            "score": cls._optional_float(
                value.get("score")
            ),
            "field": cls._normalize_named_id(field),
            "subfield": cls._normalize_named_id(subfield),
            "domain": cls._normalize_named_id(domain),
        }

    @classmethod
    def _normalize_topics(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        return [
            topic
            for topic in (
                cls._normalize_topic(item)
                for item in cls._list_value(value)
            )
            if topic
        ]

    @classmethod
    def _normalize_named_id(
        cls,
        value: Any,
    ) -> dict[str, str]:
        if not isinstance(value, Mapping):
            return {}

        return {
            "id": cls._short_openalex_id(
                normalize_space(value.get("id"))
            ),
            "display_name": normalize_space(
                value.get("display_name")
            ),
        }

    @classmethod
    def _normalize_keywords(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                keyword = normalize_space(
                    item.get("display_name")
                    or item.get("keyword")
                    or item.get("name")
                )
                score = cls._optional_float(
                    item.get("score")
                )
                keyword_id = cls._short_openalex_id(
                    normalize_space(item.get("id"))
                )
            else:
                keyword = normalize_space(item)
                score = None
                keyword_id = ""

            if keyword:
                result.append(
                    {
                        "id": keyword_id,
                        "display_name": keyword,
                        "score": score,
                    }
                )

        return result

    @classmethod
    def _normalize_grants(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if not isinstance(item, Mapping):
                continue

            result.append(
                {
                    "funder": cls._short_openalex_id(
                        normalize_space(
                            item.get("funder")
                        )
                    ),
                    "funder_display_name": normalize_space(
                        item.get(
                            "funder_display_name"
                        )
                    ),
                    "award_id": normalize_space(
                        item.get("award_id")
                    ),
                }
            )

        return result

    @classmethod
    def _normalize_funders(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if not isinstance(item, Mapping):
                continue

            result.append(
                {
                    "id": cls._short_openalex_id(
                        normalize_space(item.get("id"))
                    ),
                    "display_name": normalize_space(
                        item.get("display_name")
                    ),
                    "ror": normalize_space(item.get("ror")),
                    "country_code": normalize_space(
                        item.get("country_code")
                    ),
                    "homepage_url": normalize_space(
                        item.get("homepage_url")
                    ),
                }
            )

        return result

    @classmethod
    def _normalize_mesh(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if not isinstance(item, Mapping):
                continue

            result.append(
                {
                    "descriptor_ui": normalize_space(
                        item.get("descriptor_ui")
                    ),
                    "descriptor_name": normalize_space(
                        item.get("descriptor_name")
                    ),
                    "qualifier_ui": normalize_space(
                        item.get("qualifier_ui")
                    ),
                    "qualifier_name": normalize_space(
                        item.get("qualifier_name")
                    ),
                    "is_major_topic": cls._optional_bool(
                        item.get("is_major_topic")
                    ),
                }
            )

        return result

    @classmethod
    def _normalize_sdgs(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if not isinstance(item, Mapping):
                continue

            result.append(
                {
                    "id": normalize_space(item.get("id")),
                    "display_name": normalize_space(
                        item.get("display_name")
                    ),
                    "score": cls._optional_float(
                        item.get("score")
                    ),
                }
            )

        return result

    @classmethod
    def _normalize_counts_by_year(
        cls,
        value: Any,
    ) -> list[dict[str, int | None]]:
        result: list[dict[str, int | None]] = []

        for item in cls._list_value(value):
            if not isinstance(item, Mapping):
                continue

            result.append(
                {
                    "year": cls._optional_int(
                        item.get("year")
                    ),
                    "cited_by_count": cls._optional_int(
                        item.get("cited_by_count")
                    ),
                }
            )

        return result

    @classmethod
    def _normalize_identifiers(
        cls,
        value: Any,
        *,
        raw: Mapping[str, Any],
    ) -> list[dict[str, str]]:
        result: list[dict[str, str]] = []
        seen: set[tuple[str, str]] = set()

        ids = value if isinstance(value, Mapping) else {}

        known = {
            "openalex": (
                ids.get("openalex")
                or raw.get("id")
            ),
            "doi": ids.get("doi") or raw.get("doi"),
            "mag": ids.get("mag"),
            "pmid": ids.get("pmid"),
            "pmcid": ids.get("pmcid"),
        }

        labels = {
            "openalex": "OpenAlex",
            "doi": "DOI",
            "mag": "Microsoft Academic Graph",
            "pmid": "PubMed",
            "pmcid": "PubMed Central",
        }

        for key, value_item in known.items():
            identifier = normalize_space(value_item)

            if key == "openalex":
                identifier = cls._short_openalex_id(
                    identifier
                )
            elif key == "doi":
                identifier = identifier.removeprefix(
                    "https://doi.org/"
                )
            elif key == "pmid":
                identifier = identifier.removeprefix(
                    "https://pubmed.ncbi.nlm.nih.gov/"
                ).rstrip("/")
            elif key == "pmcid":
                identifier = identifier.removeprefix(
                    "https://www.ncbi.nlm.nih.gov/pmc/articles/"
                ).rstrip("/")

            pair = (
                labels[key].casefold(),
                identifier.casefold(),
            )

            if not identifier or pair in seen:
                continue

            seen.add(pair)
            result.append(
                {
                    "source": labels[key],
                    "identifier": identifier,
                }
            )

        for item in cls._list_value(
            raw.get("external_ids")
        ):
            if not isinstance(item, Mapping):
                continue

            source = normalize_space(
                item.get("source")
                or item.get("database")
            )
            identifier = normalize_space(
                item.get("identifier")
                or item.get("id")
                or item.get("value")
            )
            pair = (
                source.casefold(),
                identifier.casefold(),
            )

            if not source or not identifier or pair in seen:
                continue

            seen.add(pair)
            result.append(
                {
                    "source": source,
                    "identifier": identifier,
                }
            )

        return result

    @classmethod
    def _extract_taxonomic_mentions(
        cls,
        *,
        title: str,
        abstract: str,
        raw: Mapping[str, Any],
    ) -> list[dict[str, Any]]:
        """Extract plausible Latin binomials and trinomials."""

        enabled = raw.get(
            "_extract_taxonomic_mentions",
            True,
        )

        if enabled is False:
            return []

        text_parts = [title, abstract]

        for keyword in cls._normalize_keywords(
            raw.get("keywords")
        ):
            text_parts.append(
                normalize_space(
                    keyword.get("display_name")
                )
            )

        text = " ".join(
            part
            for part in text_parts
            if part
        )

        result: list[dict[str, Any]] = []
        seen: set[str] = set()

        for match in _INFRASPECIFIC_RE.finditer(text):
            genus, species, marker, infra = match.groups()

            if species.casefold() in _EXCLUDED_SECOND_WORDS:
                continue

            scientific_name = (
                f"{genus} {species} "
                f"{(marker + '. ') if marker else ''}{infra}"
            ).strip()

            key = scientific_name.casefold()

            if key in seen:
                continue

            seen.add(key)
            result.append(
                {
                    "scientific_name": scientific_name,
                    "canonical_name": (
                        f"{genus} {species} {infra}"
                    ),
                    "rank": "infraspecific",
                    "genus": genus,
                    "specific_epithet": species,
                    "infraspecific_epithet": infra,
                    "match_type": "trinomial",
                }
            )

        for match in _BINOMIAL_RE.finditer(text):
            genus, species = match.groups()

            if species.casefold() in _EXCLUDED_SECOND_WORDS:
                continue

            scientific_name = f"{genus} {species}"
            key = scientific_name.casefold()

            if key in seen:
                continue

            seen.add(key)
            result.append(
                {
                    "scientific_name": scientific_name,
                    "canonical_name": scientific_name,
                    "rank": "species",
                    "genus": genus,
                    "specific_epithet": species,
                    "infraspecific_epithet": "",
                    "match_type": "binomial",
                }
            )

        return result

    @classmethod
    def _normalize_fulltext(
        cls,
        value: Any,
    ) -> dict[str, Any]:
        if not isinstance(value, Mapping):
            return {}

        return {
            "is_available": cls._optional_bool(
                value.get("is_available")
            ),
            "num_tokens": cls._optional_int(
                value.get("num_tokens")
            ),
        }

    @classmethod
    def _normalize_apc(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if not isinstance(item, Mapping):
                continue

            result.append(
                {
                    "value": cls._optional_float(
                        item.get("value")
                    ),
                    "currency": normalize_space(
                        item.get("currency")
                    ),
                    "value_usd": cls._optional_float(
                        item.get("value_usd")
                    ),
                    "provenance": normalize_space(
                        item.get("provenance")
                    ),
                }
            )

        return result

    @classmethod
    def _normalize_datasets(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                result.append(
                    {
                        "id": normalize_space(
                            item.get("id")
                        ),
                        "title": normalize_space(
                            item.get("title")
                            or item.get("display_name")
                        ),
                        "doi": normalize_space(
                            item.get("doi")
                        ).removeprefix(
                            "https://doi.org/"
                        ),
                        "url": normalize_space(
                            item.get("url")
                        ),
                        "repository": normalize_space(
                            item.get("repository")
                        ),
                        "raw": dict(item),
                    }
                )

        return result

    @classmethod
    def _normalize_versions(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                result.append(
                    {
                        "id": cls._short_openalex_id(
                            normalize_space(
                                item.get("id")
                            )
                        ),
                        "version": normalize_space(
                            item.get("version")
                        ),
                        "url": normalize_space(
                            item.get("url")
                        ),
                        "date": normalize_space(
                            item.get("date")
                        ),
                        "raw": dict(item),
                    }
                )

        return result

    @staticmethod
    def _reconstruct_abstract(
        value: Any,
    ) -> str:
        """Reconstruct OpenAlex's inverted-index abstract."""

        if not isinstance(value, Mapping):
            return ""

        positions: dict[int, str] = {}

        for token, indexes in value.items():
            token_text = normalize_space(token)

            if not token_text:
                continue

            for index in Provider._list_value(indexes):
                try:
                    positions[int(index)] = token_text
                except (TypeError, ValueError):
                    continue

        return " ".join(
            positions[index]
            for index in sorted(positions)
        )

    @staticmethod
    def _normalize_id_list(
        value: Any,
    ) -> list[str]:
        result: list[str] = []
        seen: set[str] = set()

        for item in Provider._list_value(value):
            identifier = Provider._short_openalex_id(
                normalize_space(item)
            )
            key = identifier.casefold()

            if not identifier or key in seen:
                continue

            seen.add(key)
            result.append(identifier)

        return result

    @staticmethod
    def _normalize_mapping(
        value: Any,
    ) -> dict[str, Any]:
        return dict(value) if isinstance(value, Mapping) else {}

    @staticmethod
    def _short_openalex_id(value: str) -> str:
        return (
            normalize_space(value)
            .removeprefix("https://openalex.org/")
            .removeprefix("http://openalex.org/")
        )

    @staticmethod
    def _clean_orcid(value: str) -> str:
        return (
            normalize_space(value)
            .removeprefix("https://orcid.org/")
            .removeprefix("http://orcid.org/")
        )

    @staticmethod
    def _infer_taxonomic_rank(
        scientific_name: str,
    ) -> str:
        words = normalize_space(scientific_name).split()

        if len(words) == 2:
            return "species"

        if len(words) >= 3:
            return "infraspecific"

        return "unknown"

    @staticmethod
    def _infer_genus(
        scientific_name: str,
    ) -> str:
        words = normalize_space(scientific_name).split()

        if (
            len(words) >= 2
            and words[0][:1].isupper()
            and words[0][1:].islower()
        ):
            return words[0]

        return ""

    @staticmethod
    def _nested_value(
        record: Mapping[str, Any],
        *keys: str,
    ) -> Any:
        value: Any = record

        for key in keys:
            if not isinstance(value, Mapping):
                return None
            value = value.get(key)

        return value

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

    @staticmethod
    def _optional_float(value: Any) -> float | None:
        if value in (None, ""):
            return None

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
