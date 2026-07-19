#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/wikispecies.py

Wikispecies provider plug-in.

Fetches one batch of Wikispecies pages with one MediaWiki API request per
provider run. The response may include page metadata, page properties,
revision content, categories, language links, internal links, templates,
images, and external links.

All provider data is preserved in Taxon.extra["raw"] while principal fields
are normalized for Speciedex reconciliation.

Copyright (c) 2026 ZZX-Laboratories

Licensed under the MIT License.
"""

from __future__ import annotations

import json
from typing import Any
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
    """Wikispecies MediaWiki API provider."""

    PROVIDER_NAME = "wikispecies"

    DEFAULT_API_URL = (
        "https://species.wikimedia.org/w/api.php"
    )

    DEFAULT_SITE_URL = (
        "https://species.wikimedia.org/wiki/"
    )

    MAX_PAGE_SIZE = 500

    TAXONOMIC_RANKS = {
        "domain",
        "superkingdom",
        "kingdom",
        "subkingdom",
        "infrakingdom",
        "superphylum",
        "phylum",
        "subphylum",
        "infraphylum",
        "superclass",
        "class",
        "subclass",
        "infraclass",
        "superorder",
        "order",
        "suborder",
        "infraorder",
        "parvorder",
        "superfamily",
        "family",
        "subfamily",
        "tribe",
        "subtribe",
        "genus",
        "subgenus",
        "section",
        "subsection",
        "series",
        "species",
        "subspecies",
        "variety",
        "subvariety",
        "form",
        "subform",
        "strain",
        "cultivar",
        "hybrid",
        "clade",
        "unranked",
    }

    EXCLUDED_TITLE_PREFIXES = {
        "author:",
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
        "wikispecies:",
    }

    EXCLUDED_PAGE_TITLES = {
        "main page",
        "wikispecies",
    }

    def fetch(self) -> Batch:
        """
        Fetch one Wikispecies page batch using one MediaWiki request.

        The complete MediaWiki continuation object is stored in the provider
        cursor so generator and property continuation can resume correctly.
        """

        api_url = normalize_space(
            self.definition.get(
                "api_url",
                self.DEFAULT_API_URL,
            )
        )

        if not api_url:
            raise ProviderError(
                "Wikispecies api_url is empty."
            )

        site_url = normalize_space(
            self.definition.get(
                "site_url",
                self.DEFAULT_SITE_URL,
            )
        )

        namespace = safe_int(
            self.definition.get(
                "namespace",
                0,
            ),
            0,
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
                self.MAX_PAGE_SIZE,
            ),
        )

        parameters: dict[str, Any] = {
            "action": "query",
            "format": "json",
            "formatversion": 2,
            "generator": "allpages",
            "gapnamespace": namespace,
            "gaplimit": page_size,
            "gapfilterredir": "nonredirects",
            "prop": "|".join(
                (
                    "info",
                    "pageprops",
                    "revisions",
                    "categories",
                    "langlinks",
                    "links",
                    "templates",
                    "images",
                    "extlinks",
                )
            ),
            "inprop": "|".join(
                (
                    "url",
                    "displaytitle",
                    "protection",
                    "talkid",
                    "subjectid",
                )
            ),
            "rvlimit": 1,
            "rvslots": "main",
            "rvprop": "|".join(
                (
                    "ids",
                    "timestamp",
                    "user",
                    "userid",
                    "comment",
                    "flags",
                    "size",
                    "sha1",
                    "contentmodel",
                    "content",
                )
            ),
            "cllimit": "max",
            "lllimit": "max",
            "pllimit": "max",
            "tllimit": "max",
            "imlimit": "max",
            "ellimit": "max",
        }

        continuation = self._decode_cursor(
            self.cursor
        )

        protected_parameters = {
            "action",
            "format",
            "formatversion",
            "generator",
            "gapnamespace",
            "gaplimit",
            "gapfilterredir",
            "prop",
            "inprop",
            "rvlimit",
            "rvslots",
            "rvprop",
            "cllimit",
            "lllimit",
            "pllimit",
            "tllimit",
            "imlimit",
            "ellimit",
        }

        for key, value in continuation.items():
            if key not in protected_parameters:
                parameters[key] = value

        request_count_before = (
            self.http.requests
        )

        payload = self.http.get_json(
            api_url,
            parameters,
        )

        request_count = (
            self.http.requests
            - request_count_before
        )

        if request_count < 1:
            raise ProviderError(
                "Wikispecies provider completed without "
                "performing an API request."
            )

        if not isinstance(payload, dict):
            raise ProviderError(
                "Wikispecies returned a non-object JSON response."
            )

        warnings = payload.get("warnings")

        if isinstance(warnings, dict):
            warning_messages = []

            for module_name, warning in warnings.items():
                if isinstance(warning, dict):
                    message = normalize_space(
                        warning.get("*")
                        or warning.get("warnings")
                        or warning.get("html")
                    )
                else:
                    message = normalize_space(
                        warning
                    )

                if message:
                    warning_messages.append(
                        f"{module_name}: {message}"
                    )

            if warning_messages:
                self.state[
                    "last_api_warnings"
                ] = warning_messages

        api_error = payload.get("error")

        if isinstance(api_error, dict):
            code = normalize_space(
                api_error.get("code")
            )

            information = normalize_space(
                api_error.get("info")
            )

            raise ProviderError(
                "Wikispecies API error"
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

        query = payload.get(
            "query",
            {},
        )

        if not isinstance(
            query,
            dict,
        ):
            query = {}

        raw_pages = query.get(
            "pages",
            [],
        )

        if isinstance(
            raw_pages,
            dict,
        ):
            raw_pages = list(
                raw_pages.values()
            )

        if not isinstance(
            raw_pages,
            list,
        ):
            raise ProviderError(
                "Wikispecies response field "
                "`query.pages` is not a list."
            )

        retrieved_at = now()
        records: list[Taxon] = []

        for raw_page in raw_pages:
            if not isinstance(
                raw_page,
                dict,
            ):
                continue

            record = self._normalize_page(
                raw_page=raw_page,
                api_url=api_url,
                site_url=site_url,
                retrieved_at=retrieved_at,
            )

            if record is not None:
                records.append(record)

        raw_continuation = payload.get(
            "continue"
        )

        if isinstance(
            raw_continuation,
            dict,
        ) and raw_continuation:
            next_cursor = json.dumps(
                raw_continuation,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )

            exhausted = False
        else:
            next_cursor = None
            exhausted = True

        return Batch(
            records=records,
            next_cursor=next_cursor,
            exhausted=exhausted,
            requests=request_count,
            raw=len(raw_pages),
        )

    def _normalize_page(
        self,
        raw_page: dict[str, Any],
        api_url: str,
        site_url: str,
        retrieved_at: str,
    ) -> Taxon | None:
        """Normalize one Wikispecies page and preserve its full payload."""

        page_id = raw_page.get(
            "pageid"
        )

        title = normalize_space(
            raw_page.get("title")
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
            dict,
        ):
            page_properties = {}

        revisions = self._list_value(
            raw_page.get("revisions")
        )

        latest_revision = (
            revisions[0]
            if (
                revisions
                and isinstance(
                    revisions[0],
                    dict,
                )
            )
            else {}
        )

        revision_slots = latest_revision.get(
            "slots",
            {},
        )

        if not isinstance(
            revision_slots,
            dict,
        ):
            revision_slots = {}

        main_slot = revision_slots.get(
            "main",
            {},
        )

        if not isinstance(
            main_slot,
            dict,
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

        revision_content = (
            str(revision_content)
            if revision_content is not None
            else ""
        )

        categories = self._extract_titles(
            raw_page.get("categories")
        )

        language_links = (
            self._extract_language_links(
                raw_page.get("langlinks")
            )
        )

        internal_links = self._extract_titles(
            raw_page.get("links")
        )

        templates = self._extract_titles(
            raw_page.get("templates")
        )

        images = self._extract_titles(
            raw_page.get("images")
        )

        external_links = (
            self._extract_external_links(
                raw_page.get("extlinks")
            )
        )

        rank = self._infer_rank(
            title=title,
            page_properties=page_properties,
            categories=categories,
            content=revision_content,
        )

        taxonomy = self._extract_taxonomy(
            revision_content
        )

        canonical_name = self._canonical_name(
            title=title,
            page_properties=page_properties,
        )

        scientific_name = normalize_space(
            self._first_value(
                page_properties,
                "wikibase-title",
                "displaytitle",
            )
        )

        scientific_name = self._strip_markup(
            scientific_name
        )

        if not scientific_name:
            scientific_name = canonical_name

        status = self._infer_status(
            categories=categories,
            page_properties=page_properties,
            content=revision_content,
        )

        synonyms = self._extract_synonyms(
            content=revision_content,
        )

        authorship = self._extract_authorship(
            revision_content
        )

        full_url = normalize_space(
            raw_page.get("fullurl")
        )

        if not full_url:
            full_url = (
                site_url.rstrip("/")
                + "/"
                + self._encode_wiki_title(
                    title
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
            status=status,
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
                "source": "Wikispecies",
                "endpoint": api_url,
                "reference_only": True,
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
                "canonical_url": normalize_space(
                    raw_page.get(
                        "canonicalurl"
                    )
                ),
                "full_url": full_url,
                "edit_url": normalize_space(
                    raw_page.get(
                        "editurl"
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
                "page_language_html_code": (
                    normalize_space(
                        raw_page.get(
                            "pagelanguagehtmlcode"
                        )
                    )
                ),
                "page_language_direction": (
                    normalize_space(
                        raw_page.get(
                            "pagelanguagedir"
                        )
                    )
                ),
                "touched": normalize_space(
                    raw_page.get("touched")
                ),
                "last_revision_id": raw_page.get(
                    "lastrevid"
                ),
                "length": raw_page.get(
                    "length"
                ),
                "protection": self._list_value(
                    raw_page.get(
                        "protection"
                    )
                ),
                "restriction_types": (
                    self._list_value(
                        raw_page.get(
                            "restrictiontypes"
                        )
                    )
                ),
                "page_properties": page_properties,
                "categories": categories,
                "language_links": language_links,
                "internal_links": internal_links,
                "templates": templates,
                "images": images,
                "external_links": external_links,
                "latest_revision": latest_revision,
                "revision_id": latest_revision.get(
                    "revid"
                ),
                "parent_revision_id": (
                    latest_revision.get(
                        "parentid"
                    )
                ),
                "revision_timestamp": (
                    revision_timestamp
                ),
                "revision_user": normalize_space(
                    latest_revision.get(
                        "user"
                    )
                ),
                "revision_user_id": (
                    latest_revision.get(
                        "userid"
                    )
                ),
                "revision_comment": (
                    normalize_space(
                        latest_revision.get(
                            "comment"
                        )
                    )
                ),
                "revision_size": (
                    latest_revision.get(
                        "size"
                    )
                ),
                "revision_sha1": (
                    latest_revision.get(
                        "sha1"
                    )
                ),
                "revision_content_model": (
                    normalize_space(
                        main_slot.get(
                            "contentmodel"
                        )
                        or latest_revision.get(
                            "contentmodel"
                        )
                    )
                ),
                "revision_content": revision_content,
                "inferred_taxonomy": taxonomy,
                "raw": raw_page,
            },
        )

    def _is_candidate_page(
        self,
        page: dict[str, Any],
        title: str,
    ) -> bool:
        """Reject non-main and administrative pages."""

        namespace = safe_int(
            page.get("ns"),
            0,
        )

        configured_namespace = safe_int(
            self.definition.get(
                "namespace",
                0,
            ),
            0,
        )

        if namespace != configured_namespace:
            return False

        normalized_title = title.casefold()

        if (
            normalized_title
            in self.EXCLUDED_PAGE_TITLES
        ):
            return False

        if any(
            normalized_title.startswith(
                prefix
            )
            for prefix
            in self.EXCLUDED_TITLE_PREFIXES
        ):
            return False

        return True

    def _canonical_name(
        self,
        title: str,
        page_properties: dict[str, Any],
    ) -> str:
        """Determine the most useful canonical name available."""

        candidates = (
            page_properties.get(
                "wikibase-title"
            ),
            page_properties.get(
                "displaytitle"
            ),
            title,
        )

        for candidate in candidates:
            value = self._strip_markup(
                normalize_space(
                    candidate
                )
            )

            if value:
                return value

        return title

    def _infer_rank(
        self,
        title: str,
        page_properties: dict[str, Any],
        categories: list[str],
        content: str,
    ) -> str:
        """Infer taxonomic rank from properties, categories, or wikitext."""

        property_candidates = (
            page_properties.get(
                "taxonrank"
            ),
            page_properties.get(
                "taxon_rank"
            ),
            page_properties.get(
                "rank"
            ),
        )

        for candidate in property_candidates:
            rank = self._normalize_rank(
                candidate
            )

            if rank:
                return rank

        for category in categories:
            normalized = normalize_space(
                category
            ).casefold()

            if normalized.startswith(
                "category:"
            ):
                normalized = normalized[
                    len("category:"):
                ].strip()

            for rank in sorted(
                self.TAXONOMIC_RANKS,
                key=len,
                reverse=True,
            ):
                if (
                    normalized == rank
                    or normalized == f"{rank}s"
                    or normalized.endswith(
                        f" {rank}"
                    )
                    or normalized.endswith(
                        f" {rank}s"
                    )
                    or f" {rank} " in normalized
                ):
                    return rank

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

            if field_name not in {
                "rank",
                "taxon rank",
            }:
                continue

            rank = self._normalize_rank(
                self._clean_wikitext_value(
                    right
                )
            )

            if rank:
                return rank

        words = title.split()

        if len(words) == 2:
            return "species"

        if len(words) == 3:
            return "subspecies"

        return "unknown"

    def _normalize_rank(
        self,
        value: Any,
    ) -> str:
        """Normalize an inferred taxonomic rank."""

        rank = normalize_space(
            value
        ).casefold()

        rank = rank.replace(
            "_",
            " ",
        ).replace(
            "-",
            " ",
        )

        rank = " ".join(
            rank.split()
        )

        aliases = {
            "regnum": "kingdom",
            "divisio": "phylum",
            "division": "phylum",
            "classis": "class",
            "ordo": "order",
            "familia": "family",
            "tribus": "tribe",
            "varietas": "variety",
            "forma": "form",
        }

        rank = aliases.get(
            rank,
            rank,
        )

        if rank in self.TAXONOMIC_RANKS:
            return rank

        return ""

    def _infer_status(
        self,
        categories: list[str],
        page_properties: dict[str, Any],
        content: str,
    ) -> str:
        """Infer whether a page represents an accepted name or synonym."""

        property_values = []

        for value in page_properties.values():
            if isinstance(
                value,
                (
                    str,
                    int,
                    float,
                ),
            ):
                property_values.append(
                    normalize_space(value)
                )

        combined = " ".join(
            [
                *categories,
                *property_values,
                content[:10000],
            ]
        ).casefold()

        if any(
            marker in combined
            for marker in (
                "taxonomic synonym",
                "synonym of",
                "{{synonym",
                "invalid taxon",
                "invalid name",
                "nomen nudum",
                "nomen dubium",
                "junior homonym",
                "senior homonym",
            )
        ):
            return "synonym"

        if any(
            marker in combined
            for marker in (
                "accepted taxon",
                "accepted name",
                "{{taxon",
                "{{species",
            )
        ):
            return "accepted"

        return "reference"

    def _extract_taxonomy(
        self,
        content: str,
    ) -> dict[str, str]:
        """Extract major lineage values from page wikitext."""

        taxonomy = {
            "kingdom": "",
            "phylum": "",
            "class": "",
            "order": "",
            "family": "",
            "genus": "",
        }

        field_aliases = {
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

            for target, aliases in (
                field_aliases.items()
            ):
                if field_name not in aliases:
                    continue

                value = (
                    self._clean_wikitext_value(
                        right
                    )
                )

                if (
                    value
                    and not taxonomy[target]
                ):
                    taxonomy[target] = value

        return taxonomy

    def _extract_authorship(
        self,
        content: str,
    ) -> str:
        """Extract authority or authorship from page wikitext."""

        aliases = {
            "authority",
            "authorship",
            "author",
            "taxon authority",
            "binomial authority",
            "trinomial authority",
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

            if field_name not in aliases:
                continue

            value = self._clean_wikitext_value(
                right
            )

            if value:
                return value

        return ""

    def _extract_synonyms(
        self,
        content: str,
    ) -> list[str]:
        """Extract synonym-like values from page wikitext."""

        synonyms: list[str] = []

        aliases = {
            "synonym",
            "synonyms",
            "basionym",
            "protonym",
            "original combination",
            "original name",
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

            if field_name not in aliases:
                continue

            value = self._clean_wikitext_value(
                right
            )

            if value:
                synonyms.extend(
                    self._split_names(
                        value
                    )
                )

        unique: list[str] = []
        seen: set[str] = set()

        for synonym in synonyms:
            normalized = normalize_space(
                synonym
            )

            key = normalized.casefold()

            if (
                not normalized
                or key in seen
            ):
                continue

            seen.add(key)
            unique.append(normalized)

        return unique

    @staticmethod
    def _extract_titles(
        value: Any,
    ) -> list[str]:
        """Extract MediaWiki title values from a list property."""

        results: list[str] = []

        for item in Provider._list_value(
            value
        ):
            if isinstance(
                item,
                dict,
            ):
                title = normalize_space(
                    item.get("title")
                )
            else:
                title = normalize_space(
                    item
                )

            if title:
                results.append(title)

        return results

    @staticmethod
    def _extract_language_links(
        value: Any,
    ) -> list[dict[str, str]]:
        """Extract language-link metadata."""

        results: list[dict[str, str]] = []

        for item in Provider._list_value(
            value
        ):
            if not isinstance(
                item,
                dict,
            ):
                continue

            language = normalize_space(
                item.get("lang")
            )

            title = normalize_space(
                item.get("title")
                or item.get("*")
            )

            url = normalize_space(
                item.get("url")
            )

            if language or title or url:
                results.append(
                    {
                        "language": language,
                        "title": title,
                        "url": url,
                    }
                )

        return results

    @staticmethod
    def _extract_external_links(
        value: Any,
    ) -> list[str]:
        """Extract external URLs."""

        results: list[str] = []

        for item in Provider._list_value(
            value
        ):
            if isinstance(
                item,
                dict,
            ):
                link = normalize_space(
                    item.get("url")
                    or item.get("*")
                )
            else:
                link = normalize_space(
                    item
                )

            if link:
                results.append(link)

        return results

    @staticmethod
    def _decode_cursor(
        cursor: str | None,
    ) -> dict[str, Any]:
        """Decode a complete MediaWiki continuation object."""

        if not cursor:
            return {}

        try:
            value = json.loads(
                cursor
            )
        except json.JSONDecodeError:
            return {
                "gapcontinue": cursor,
            }

        if not isinstance(
            value,
            dict,
        ):
            return {}

        return {
            str(key): item
            for key, item in value.items()
            if item is not None
        }

    @staticmethod
    def _first_value(
        record: dict[str, Any],
        *keys: str,
    ) -> Any:
        """Return the first nonempty value."""

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
    def _list_value(
        value: Any,
    ) -> list[Any]:
        """Normalize an optional value to a list."""

        if value is None:
            return []

        if isinstance(
            value,
            list,
        ):
            return value

        return [value]

    @staticmethod
    def _encode_wiki_title(
        title: str,
    ) -> str:
        """Encode a Wikispecies page title for a URL path."""

        return quote(
            title.replace(
                " ",
                "_",
            ),
            safe="()_,-.'",
        )

    @staticmethod
    def _strip_markup(
        value: str,
    ) -> str:
        """Remove common lightweight MediaWiki display markup."""

        result = value

        replacements = {
            "'''''": "",
            "'''": "",
            "''": "",
            "&nbsp;": " ",
        }

        for old, new in replacements.items():
            result = result.replace(
                old,
                new,
            )

        if (
            result.startswith("[[")
            and result.endswith("]]")
        ):
            result = result[2:-2]

            if "|" in result:
                result = result.split(
                    "|",
                    1,
                )[-1]

        return normalize_space(result)

    @classmethod
    def _clean_wikitext_value(
        cls,
        value: Any,
    ) -> str:
        """Clean a taxonomy, synonym, or authority value."""

        result = normalize_space(
            value
        )

        if not result:
            return ""

        if "<!--" in result:
            result = result.split(
                "<!--",
                1,
            )[0]

        result = result.rstrip(
            "|}"
        ).strip()

        if (
            result.startswith("{{")
            and result.endswith("}}")
        ):
            inner = result[2:-2]

            parts = [
                normalize_space(part)
                for part in inner.split("|")
            ]

            meaningful = [
                part
                for part in parts[1:]
                if (
                    part
                    and "=" not in part
                )
            ]

            if meaningful:
                result = meaningful[-1]
            elif parts:
                result = parts[0]

        result = cls._strip_markup(
            result
        )

        if (
            result.startswith("[[")
            and result.endswith("]]")
        ):
            result = result[2:-2]

        if (
            "|" in result
            and "[[" not in result
        ):
            pieces = [
                normalize_space(piece)
                for piece in result.split("|")
                if normalize_space(piece)
            ]

            if pieces:
                result = pieces[-1]

        return normalize_space(result)

    @staticmethod
    def _split_names(
        value: str,
    ) -> list[str]:
        """Split a compact synonym field conservatively."""

        normalized = value.replace(
            "<br />",
            "\n",
        ).replace(
            "<br/>",
            "\n",
        ).replace(
            "<br>",
            "\n",
        )

        results: list[str] = []

        for line in normalized.splitlines():
            line = normalize_space(
                line.lstrip(
                    "*#;:"
                )
            )

            if not line:
                continue

            if ";" in line:
                results.extend(
                    normalize_space(item)
                    for item in line.split(";")
                    if normalize_space(item)
                )
            else:
                results.append(line)

        return results
