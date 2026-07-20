#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/wikipedia.py

Wikipedia enrichment provider plug-in.

This provider uses the MediaWiki API to discover and normalize taxonomy-related
Wikipedia pages. It is intentionally supplemental: Wikipedia contributes
descriptions, vernacular names, categories, links, images, and article metadata,
while Wikispecies and primary taxonomic authorities remain preferred for
canonical taxonomy.

Each fetch call performs one logical MediaWiki API request, preserves the full
page payload under ``Taxon.extra["raw"]``, and returns normalized Taxon objects
through the shared provider contract.

Copyright (c) 2026 ZZX-Laboratories
Licensed under the MIT License.
"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping
from urllib.parse import quote

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
    """Wikipedia MediaWiki API enrichment provider."""

    PROVIDER_NAME = "wikipedia"

    DEFAULT_API_URL = "https://en.wikipedia.org/w/api.php"
    DEFAULT_SITE_URL = "https://en.wikipedia.org/wiki/"

    DEFAULT_PAGE_SIZE = 100
    MAX_PAGE_SIZE = 500

    DEFAULT_NAMESPACE = 0

    TAXONOMIC_CATEGORY_MARKERS = (
        "species",
        "genera",
        "families",
        "orders",
        "classes",
        "phyla",
        "kingdoms",
        "subspecies",
        "varieties",
        "cultivars",
        "strains",
        "taxa",
        "taxonomy",
        "biota",
        "flora",
        "fauna",
        "fungi",
        "bacteria",
        "archaea",
        "viruses",
    )

    EXCLUDED_TITLE_PREFIXES = {
        "category:",
        "file:",
        "help:",
        "mediawiki:",
        "module:",
        "portal:",
        "special:",
        "talk:",
        "template:",
        "user:",
        "wikipedia:",
    }

    EXCLUDED_PAGE_TITLES = {
        "main page",
        "taxonomy",
        "species",
        "genus",
    }

    RANK_ALIASES = {
        "domain": "domain",
        "superkingdom": "superkingdom",
        "kingdom": "kingdom",
        "subkingdom": "subkingdom",
        "phylum": "phylum",
        "division": "phylum",
        "class": "class",
        "order": "order",
        "family": "family",
        "genus": "genus",
        "species": "species",
        "subspecies": "subspecies",
        "variety": "variety",
        "form": "form",
        "strain": "strain",
        "cultivar": "cultivar",
        "clade": "clade",
        "virus": "virus",
        "unranked": "unranked",
    }

    _COMMENT_PATTERN = re.compile(r"<!--.*?-->", re.DOTALL)
    _TAG_PATTERN = re.compile(r"<[^>]+>")
    _LINK_PATTERN = re.compile(r"\[\[(?:[^\]|]+\|)?([^\]]+)\]\]")
    _TEMPLATE_PATTERN = re.compile(r"\{\{([^{}]+)\}\}")
    _PARENTHETICAL_PATTERN = re.compile(r"\s*\([^()]+\)\s*$")

    def fetch(self) -> Batch:
        """Fetch one resumable Wikipedia article batch."""

        api_url = normalize_space(
            self.definition.get(
                "api_url",
                self.DEFAULT_API_URL,
            )
        )

        site_url = normalize_space(
            self.definition.get(
                "site_url",
                self.DEFAULT_SITE_URL,
            )
        )

        if not api_url:
            raise ProviderError(
                "Wikipedia api_url is empty."
            )

        if not (
            api_url.startswith("https://")
            or api_url.startswith("http://")
        ):
            raise ProviderError(
                "Wikipedia api_url must use HTTP or HTTPS."
            )

        if not site_url:
            raise ProviderError(
                "Wikipedia site_url is empty."
            )

        namespace = safe_int(
            self.definition.get(
                "namespace",
                self.DEFAULT_NAMESPACE,
            ),
            self.DEFAULT_NAMESPACE,
        )

        configured_page_size = safe_int(
            self.definition.get(
                "page_size",
                self.DEFAULT_PAGE_SIZE,
            ),
            self.DEFAULT_PAGE_SIZE,
        )

        page_size = max(
            1,
            min(
                configured_page_size,
                self.batch_size,
                self.MAX_PAGE_SIZE,
            ),
        )

        generator = normalize_space(
            self.definition.get(
                "generator",
                "allpages",
            )
        ).casefold()

        if generator not in {
            "allpages",
            "categorymembers",
        }:
            raise ProviderError(
                "Wikipedia generator must be 'allpages' or 'categorymembers'."
            )

        parameters = self._base_parameters(
            generator=generator,
            namespace=namespace,
            page_size=page_size,
        )

        continuation = self._decode_cursor(
            self.cursor
        )

        protected = set(parameters)

        for key, value in continuation.items():
            if key not in protected:
                parameters[key] = value

        requests_before = self.http.requests

        payload = self.http.get_json(
            api_url,
            parameters,
        )

        request_count = (
            self.http.requests
            - requests_before
        )

        if request_count < 1:
            raise ProviderError(
                "Wikipedia fetch completed without an API request."
            )

        if not isinstance(
            payload,
            Mapping,
        ):
            raise ProviderError(
                "Wikipedia returned a non-object JSON response."
            )

        self._raise_api_error(
            payload
        )
        self._remember_api_warnings(
            payload
        )

        query = payload.get(
            "query",
            {},
        )

        if not isinstance(
            query,
            Mapping,
        ):
            query = {}

        raw_pages = query.get(
            "pages",
            [],
        )

        if isinstance(
            raw_pages,
            Mapping,
        ):
            raw_pages = list(
                raw_pages.values()
            )

        if not isinstance(
            raw_pages,
            list,
        ):
            raise ProviderError(
                "Wikipedia response field query.pages is not a list."
            )

        retrieved_at = now()
        records: list[Taxon] = []

        for raw_page in raw_pages:
            if not isinstance(
                raw_page,
                Mapping,
            ):
                continue

            record = self._normalize_page(
                raw_page=dict(raw_page),
                api_url=api_url,
                site_url=site_url,
                retrieved_at=retrieved_at,
            )

            if record is not None:
                records.append(
                    record
                )

        raw_continuation = payload.get(
            "continue"
        )

        if isinstance(
            raw_continuation,
            Mapping,
        ) and raw_continuation:
            next_cursor = self._encode_cursor(
                raw_continuation
            )
            exhausted = False
        else:
            next_cursor = None
            exhausted = True

        if (
            not exhausted
            and self.cursor
            and next_cursor == self.cursor
        ):
            raise ProviderError(
                "Wikipedia returned an unchanged continuation cursor."
            )

        return Batch(
            records=records,
            next_cursor=next_cursor,
            exhausted=exhausted,
            requests=request_count,
            raw=len(raw_pages),
        )

    def _base_parameters(
        self,
        *,
        generator: str,
        namespace: int,
        page_size: int,
    ) -> dict[str, Any]:
        """Build one MediaWiki query configuration."""

        parameters: dict[str, Any] = {
            "action": "query",
            "format": "json",
            "formatversion": 2,
            "prop": "|".join(
                (
                    "info",
                    "pageprops",
                    "extracts",
                    "revisions",
                    "categories",
                    "langlinks",
                    "links",
                    "templates",
                    "images",
                    "extlinks",
                    "pageimages",
                )
            ),
            "inprop": "url|displaytitle",
            "exintro": 1,
            "explaintext": 1,
            "exsectionformat": "plain",
            "rvslots": "main",
            "rvprop": "ids|timestamp|user|userid|comment|flags|size|sha1|contentmodel|content",
            "cllimit": "max",
            "lllimit": "max",
            "pllimit": "max",
            "tllimit": "max",
            "imlimit": "max",
            "ellimit": "max",
            "piprop": "thumbnail|name|original",
            "pithumbsize": safe_int(
                self.definition.get(
                    "thumbnail_size",
                    1024,
                ),
                1024,
            ),
        }

        if generator == "allpages":
            parameters.update(
                {
                    "generator": "allpages",
                    "gapnamespace": namespace,
                    "gaplimit": page_size,
                    "gapfilterredir": "nonredirects",
                }
            )
        else:
            category = normalize_space(
                self.definition.get(
                    "category",
                    "Category:Species",
                )
            )

            if not category:
                raise ProviderError(
                    "Wikipedia categorymembers generator requires a category."
                )

            if not category.casefold().startswith(
                "category:"
            ):
                category = (
                    "Category:"
                    + category
                )

            parameters.update(
                {
                    "generator": "categorymembers",
                    "gcmtitle": category,
                    "gcmnamespace": namespace,
                    "gcmlimit": page_size,
                    "gcmtype": "page|subcat",
                }
            )

        return parameters

    def _normalize_page(
        self,
        *,
        raw_page: dict[str, Any],
        api_url: str,
        site_url: str,
        retrieved_at: str,
    ) -> Taxon | None:
        """Normalize one Wikipedia page as supplemental taxon metadata."""

        page_id = raw_page.get(
            "pageid"
        )

        title = normalize_space(
            raw_page.get(
                "title"
            )
        )

        if (
            page_id in (
                None,
                "",
            )
            or not title
        ):
            return None

        if not self._is_candidate_page(
            raw_page,
            title,
        ):
            return None

        page_properties = raw_page.get(
            "pageprops",
            {},
        )

        if not isinstance(
            page_properties,
            Mapping,
        ):
            page_properties = {}

        categories = self._extract_titles(
            raw_page.get(
                "categories"
            )
        )

        revisions = self._list_value(
            raw_page.get(
                "revisions"
            )
        )

        latest_revision = (
            revisions[0]
            if (
                revisions
                and isinstance(
                    revisions[0],
                    Mapping,
                )
            )
            else {}
        )

        slots = latest_revision.get(
            "slots",
            {},
        )

        if not isinstance(
            slots,
            Mapping,
        ):
            slots = {}

        main_slot = slots.get(
            "main",
            {},
        )

        if not isinstance(
            main_slot,
            Mapping,
        ):
            main_slot = {}

        revision_content = self._first_value(
            main_slot,
            "content",
            "*",
        )

        if revision_content is None:
            revision_content = self._first_value(
                latest_revision,
                "content",
                "*",
            )

        content = (
            str(revision_content)
            if revision_content is not None
            else ""
        )

        extract = normalize_space(
            raw_page.get(
                "extract"
            )
        )

        scientific_name = self._scientific_name(
            title=title,
            page_properties=page_properties,
            content=content,
        )

        if not scientific_name:
            return None

        canonical_name = self._canonical_name(
            scientific_name
        )

        rank = self._infer_rank(
            title=title,
            categories=categories,
            content=content,
            page_properties=page_properties,
        )

        taxonomy = self._extract_taxonomy(
            content
        )

        authorship = self._extract_named_field(
            content,
            {
                "binomial authority",
                "trinomial authority",
                "authority",
                "taxon authority",
                "authorship",
            },
        )

        synonyms = self._extract_synonyms(
            content,
            scientific_name=scientific_name,
            canonical_name=canonical_name,
        )

        common_names = self._extract_common_names(
            title=title,
            content=content,
            page_properties=page_properties,
        )

        full_url = normalize_space(
            raw_page.get(
                "fullurl"
            )
        ) or (
            site_url.rstrip("/")
            + "/"
            + quote(
                title.replace(
                    " ",
                    "_",
                ),
                safe="()_,-.'",
            )
        )

        revision_timestamp = normalize_space(
            latest_revision.get(
                "timestamp"
            )
        )

        return Taxon(
            provider=self.name,
            provider_id=str(page_id),
            scientific_name=scientific_name,
            canonical_name=canonical_name,
            rank=rank,
            status="reference",
            authorship=authorship,
            kingdom=taxonomy.get(
                "kingdom",
                "",
            ),
            phylum=taxonomy.get(
                "phylum",
                "",
            ),
            class_name=taxonomy.get(
                "class",
                "",
            ),
            order=taxonomy.get(
                "order",
                "",
            ),
            family=taxonomy.get(
                "family",
                "",
            ),
            genus=taxonomy.get(
                "genus",
                "",
            ),
            accepted_provider_id="",
            source_url=full_url,
            source_modified=revision_timestamp,
            retrieved_at=retrieved_at,
            synonyms=synonyms,
            extra={
                "source": "Wikipedia",
                "reference_only": True,
                "enrichment_only": True,
                "endpoint": api_url,
                "page_id": page_id,
                "namespace": raw_page.get(
                    "ns"
                ),
                "title": title,
                "display_title": normalize_space(
                    raw_page.get(
                        "displaytitle"
                    )
                ),
                "description": normalize_space(
                    page_properties.get(
                        "wikibase-shortdesc"
                    )
                ),
                "extract": extract,
                "common_names": common_names,
                "full_url": full_url,
                "canonical_url": normalize_space(
                    raw_page.get(
                        "canonicalurl"
                    )
                ),
                "content_model": normalize_space(
                    raw_page.get(
                        "contentmodel"
                    )
                ),
                "page_language": normalize_space(
                    raw_page.get(
                        "pagelanguage"
                    )
                ),
                "categories": categories,
                "language_links": self._extract_language_links(
                    raw_page.get(
                        "langlinks"
                    )
                ),
                "internal_links": self._extract_titles(
                    raw_page.get(
                        "links"
                    )
                ),
                "templates": self._extract_titles(
                    raw_page.get(
                        "templates"
                    )
                ),
                "images": self._extract_titles(
                    raw_page.get(
                        "images"
                    )
                ),
                "external_links": self._extract_external_links(
                    raw_page.get(
                        "extlinks"
                    )
                ),
                "thumbnail": self._mapping_or_empty(
                    raw_page.get(
                        "thumbnail"
                    )
                ),
                "original_image": self._mapping_or_empty(
                    raw_page.get(
                        "original"
                    )
                ),
                "page_image": normalize_space(
                    raw_page.get(
                        "pageimage"
                    )
                ),
                "latest_revision": dict(
                    latest_revision
                ),
                "revision_id": latest_revision.get(
                    "revid"
                ),
                "parent_revision_id": latest_revision.get(
                    "parentid"
                ),
                "revision_timestamp": revision_timestamp,
                "revision_sha1": latest_revision.get(
                    "sha1"
                ),
                "revision_size": latest_revision.get(
                    "size"
                ),
                "revision_content": content,
                "inferred_taxonomy": taxonomy,
                "page_properties": dict(
                    page_properties
                ),
                "raw": raw_page,
            },
        )

    def _is_candidate_page(
        self,
        page: Mapping[str, Any],
        title: str,
    ) -> bool:
        namespace = safe_int(
            page.get(
                "ns"
            ),
            self.DEFAULT_NAMESPACE,
        )

        configured_namespace = safe_int(
            self.definition.get(
                "namespace",
                self.DEFAULT_NAMESPACE,
            ),
            self.DEFAULT_NAMESPACE,
        )

        if namespace != configured_namespace:
            return False

        normalized_title = title.casefold()

        if normalized_title in self.EXCLUDED_PAGE_TITLES:
            return False

        if any(
            normalized_title.startswith(
                prefix
            )
            for prefix in self.EXCLUDED_TITLE_PREFIXES
        ):
            return False

        if bool(
            self.definition.get(
                "require_taxonomic_categories",
                False,
            )
        ):
            categories = [
                value.casefold()
                for value in self._extract_titles(
                    page.get(
                        "categories"
                    )
                )
            ]

            return any(
                marker in category
                for category in categories
                for marker in self.TAXONOMIC_CATEGORY_MARKERS
            )

        return True

    def _scientific_name(
        self,
        *,
        title: str,
        page_properties: Mapping[str, Any],
        content: str,
    ) -> str:
        """Extract the best available scientific name."""

        candidates = (
            page_properties.get(
                "wikibase-title"
            ),
            self._extract_named_field(
                content,
                {
                    "binomial",
                    "trinomial",
                    "taxon",
                    "scientific name",
                    "name",
                },
            ),
            title,
        )

        for candidate in candidates:
            value = self._strip_markup(
                normalize_space(
                    candidate
                )
            )

            if self._looks_like_scientific_name(
                value
            ):
                return value

        return ""

    @staticmethod
    def _canonical_name(
        scientific_name: str,
    ) -> str:
        return normalize_space(
            Provider._PARENTHETICAL_PATTERN.sub(
                "",
                scientific_name,
            )
        )

    def _infer_rank(
        self,
        *,
        title: str,
        categories: list[str],
        content: str,
        page_properties: Mapping[str, Any],
    ) -> str:
        for candidate in (
            page_properties.get(
                "taxonrank"
            ),
            page_properties.get(
                "rank"
            ),
            self._extract_named_field(
                content,
                {
                    "rank",
                    "taxon rank",
                },
            ),
        ):
            normalized = normalize_space(
                candidate
            ).casefold().replace(
                "_",
                " ",
            ).replace(
                "-",
                " ",
            )

            normalized = self.RANK_ALIASES.get(
                normalized,
                normalized.replace(
                    " ",
                    "",
                ),
            )

            if normalized in set(
                self.RANK_ALIASES.values()
            ):
                return normalized

        combined_categories = " ".join(
            categories
        ).casefold()

        for singular, normalized in self.RANK_ALIASES.items():
            plural = (
                singular
                if singular.endswith("s")
                else singular + "s"
            )

            if (
                singular in combined_categories
                or plural in combined_categories
            ):
                return normalized

        words = title.split()

        if len(words) == 2:
            return "species"

        if len(words) == 3:
            return "subspecies"

        return "unranked"

    def _extract_taxonomy(
        self,
        content: str,
    ) -> dict[str, str]:
        aliases = {
            "kingdom": {
                "kingdom",
                "regnum",
            },
            "phylum": {
                "phylum",
                "division",
                "divisio",
            },
            "class": {
                "class",
                "classis",
            },
            "order": {
                "order",
                "ordo",
            },
            "family": {
                "family",
                "familia",
            },
            "genus": {
                "genus",
            },
        }

        return {
            target: self._extract_named_field(
                content,
                names,
            )
            for target, names in aliases.items()
        }

    def _extract_synonyms(
        self,
        content: str,
        *,
        scientific_name: str,
        canonical_name: str,
    ) -> list[str]:
        values: list[str] = []

        for alias in (
            "synonym",
            "synonyms",
            "basionym",
            "protonym",
            "original combination",
        ):
            value = self._extract_named_field(
                content,
                {alias},
            )

            if value:
                values.extend(
                    self._split_names(
                        value
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

    def _extract_common_names(
        self,
        *,
        title: str,
        content: str,
        page_properties: Mapping[str, Any],
    ) -> list[str]:
        values = [
            title,
            normalize_space(
                page_properties.get(
                    "wikibase-shortdesc"
                )
            ),
        ]

        for alias in (
            "common name",
            "common names",
            "vernacular name",
            "vernacular names",
        ):
            value = self._extract_named_field(
                content,
                {alias},
            )

            if value:
                values.extend(
                    self._split_names(
                        value
                    )
                )

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

    @classmethod
    def _extract_named_field(
        cls,
        content: str,
        aliases: set[str],
    ) -> str:
        normalized_aliases = {
            alias.casefold()
            for alias in aliases
        }

        for line in content.splitlines():
            stripped = line.strip()

            if "=" not in stripped:
                continue

            left, right = stripped.split(
                "=",
                1,
            )

            field_name = (
                left.strip()
                .lstrip("|")
                .strip()
                .casefold()
                .replace("_", " ")
            )

            if field_name not in normalized_aliases:
                continue

            value = cls._clean_wikitext_value(
                right
            )

            if value:
                return value

        return ""

    @classmethod
    def _strip_markup(
        cls,
        value: str,
    ) -> str:
        result = cls._COMMENT_PATTERN.sub(
            "",
            value,
        )
        result = cls._TAG_PATTERN.sub(
            " ",
            result,
        )
        result = result.replace(
            "'''",
            "",
        ).replace(
            "''",
            "",
        ).replace(
            "&nbsp;",
            " ",
        )
        result = cls._LINK_PATTERN.sub(
            lambda match: match.group(1),
            result,
        )
        return normalize_space(
            result
        )

    @classmethod
    def _clean_wikitext_value(
        cls,
        value: Any,
    ) -> str:
        result = normalize_space(
            value
        )

        if not result:
            return ""

        result = cls._COMMENT_PATTERN.sub(
            "",
            result,
        )
        result = result.rstrip(
            "|}"
        ).strip()

        match = cls._TEMPLATE_PATTERN.fullmatch(
            result
        )

        if match is not None:
            parts = [
                normalize_space(
                    part
                )
                for part in match.group(1).split(
                    "|"
                )
            ]

            positional = [
                part
                for part in parts[1:]
                if (
                    part
                    and "=" not in part
                )
            ]

            result = (
                positional[-1]
                if positional
                else (
                    parts[0]
                    if parts
                    else ""
                )
            )

        return cls._strip_markup(
            result
        )

    @staticmethod
    def _looks_like_scientific_name(
        value: str,
    ) -> bool:
        words = normalize_space(
            value
        ).split()

        if len(words) < 2:
            return False

        genus = words[0].lstrip(
            "×"
        )

        if not genus:
            return False

        return (
            genus[:1].isupper()
            and genus[1:].islower()
        )

    @staticmethod
    def _extract_titles(
        value: Any,
    ) -> list[str]:
        result: list[str] = []

        for item in Provider._list_value(
            value
        ):
            title = normalize_space(
                item.get(
                    "title"
                )
                if isinstance(
                    item,
                    Mapping,
                )
                else item
            )

            if title:
                result.append(
                    title
                )

        return result

    @staticmethod
    def _extract_language_links(
        value: Any,
    ) -> list[dict[str, str]]:
        result: list[dict[str, str]] = []

        for item in Provider._list_value(
            value
        ):
            if not isinstance(
                item,
                Mapping,
            ):
                continue

            entry = {
                "language": normalize_space(
                    item.get(
                        "lang"
                    )
                ),
                "title": normalize_space(
                    item.get(
                        "title"
                    )
                    or item.get(
                        "*"
                    )
                ),
                "url": normalize_space(
                    item.get(
                        "url"
                    )
                ),
            }

            if any(
                entry.values()
            ):
                result.append(
                    entry
                )

        return result

    @staticmethod
    def _extract_external_links(
        value: Any,
    ) -> list[str]:
        result: list[str] = []

        for item in Provider._list_value(
            value
        ):
            link = normalize_space(
                (
                    item.get(
                        "url"
                    )
                    or item.get(
                        "*"
                    )
                )
                if isinstance(
                    item,
                    Mapping,
                )
                else item
            )

            if link:
                result.append(
                    link
                )

        return result

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
    def _mapping_or_empty(
        value: Any,
    ) -> dict[str, Any]:
        return (
            dict(value)
            if isinstance(
                value,
                Mapping,
            )
            else {}
        )

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
    def _split_names(
        value: str,
    ) -> list[str]:
        normalized = (
            value.replace(
                "<br />",
                "\n",
            )
            .replace(
                "<br/>",
                "\n",
            )
            .replace(
                "<br>",
                "\n",
            )
        )

        result: list[str] = []

        for line in normalized.splitlines():
            line = normalize_space(
                line.lstrip(
                    "*#;:"
                )
            )

            if not line:
                continue

            if ";" in line:
                result.extend(
                    normalize_space(
                        item
                    )
                    for item in line.split(
                        ";"
                    )
                    if normalize_space(
                        item
                    )
                )
            else:
                result.append(
                    line
                )

        return result

    @staticmethod
    def _decode_cursor(
        cursor: str | None,
    ) -> dict[str, Any]:
        if not cursor:
            return {}

        try:
            value = json.loads(
                cursor
            )
        except json.JSONDecodeError as error:
            raise ProviderError(
                "Wikipedia cursor is not valid JSON."
            ) from error

        if not isinstance(
            value,
            dict,
        ):
            raise ProviderError(
                "Wikipedia cursor JSON must decode to an object."
            )

        return {
            str(key): item
            for key, item in value.items()
            if item is not None
        }

    @staticmethod
    def _encode_cursor(
        cursor: Mapping[str, Any],
    ) -> str:
        return json.dumps(
            dict(cursor),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    @staticmethod
    def _raise_api_error(
        payload: Mapping[str, Any],
    ) -> None:
        error = payload.get(
            "error"
        )

        if not isinstance(
            error,
            Mapping,
        ):
            return

        code = normalize_space(
            error.get(
                "code"
            )
        )

        information = normalize_space(
            error.get(
                "info"
            )
        )

        raise ProviderError(
            "Wikipedia API error"
            + (
                f" {code}"
                if code
                else ""
            )
            + (
                f": {information}"
                if information
                else ""
            )
        )

    def _remember_api_warnings(
        self,
        payload: Mapping[str, Any],
    ) -> None:
        warnings = payload.get(
            "warnings"
        )

        if not isinstance(
            warnings,
            Mapping,
        ):
            self.state.pop(
                "last_api_warnings",
                None,
            )
            return

        messages: list[str] = []

        for module_name, warning in warnings.items():
            if isinstance(
                warning,
                Mapping,
            ):
                message = normalize_space(
                    warning.get(
                        "*"
                    )
                    or warning.get(
                        "warnings"
                    )
                    or warning.get(
                        "html"
                    )
                )
            else:
                message = normalize_space(
                    warning
                )

            if message:
                messages.append(
                    f"{module_name}: {message}"
                )

        if messages:
            self.state[
                "last_api_warnings"
            ] = messages
        else:
            self.state.pop(
                "last_api_warnings",
                None,
            )
