#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/gbif.py

GBIF provider plug-in.

Fetches one page of GBIF taxonomic records with one logical API call per
provider run. Every field returned for each GBIF record is retained in the
raw provider payload while core taxonomic fields are normalized for
Speciedex reconciliation.

The provider supports both legacy numeric cursors and structured JSON
cursors. New cursor values preserve the active offset, page size, endpoint,
and configured filters.

Copyright (c) 2026 ZZX-Laboratories

Licensed under the MIT License.
"""

from __future__ import annotations

import json
from typing import Any

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
    """GBIF Species API provider."""

    PROVIDER_NAME = "gbif"

    DEFAULT_BASE_URL = "https://api.gbif.org/v1"
    DEFAULT_PAGE_SIZE = 500
    MAX_PAGE_SIZE = 1000

    FILTER_PARAMETERS = {
        "q": "q",
        "rank": "rank",
        "highertaxon_key": "highertaxon_key",
        "status": "status",
        "is_extinct": "is_extinct",
        "habitat": "habitat",
        "name_type": "name_type",
        "nomenclatural_status": "nomenclatural_status",
        "issue": "issue",
        "dataset_key": "dataset_key",
        "origin": "origin",
    }

    def fetch(self) -> Batch:
        """
        Fetch one GBIF species-search page.

        This method invokes HTTPClient.get_json exactly once. The HTTP client
        may internally retry a failed transport attempt according to the
        configured retry policy, but the provider does not issue secondary
        record, vernacular-name, media, occurrence, or reference requests.
        """

        base_url = normalize_space(
            self.definition.get(
                "base_url",
                self.DEFAULT_BASE_URL,
            )
        ).rstrip("/")

        if not base_url:
            raise ProviderError(
                "GBIF base_url is empty."
            )

        endpoint = f"{base_url}/species/search"

        cursor = self._decode_cursor(
            self.cursor
        )

        start_offset = safe_int(
            self.definition.get(
                "start_offset",
                0,
            ),
            0,
        )

        offset = safe_int(
            cursor.get("offset"),
            start_offset,
        )

        configured_page_size = safe_int(
            self.definition.get(
                "page_size",
                self.DEFAULT_PAGE_SIZE,
            ),
            self.DEFAULT_PAGE_SIZE,
        )

        cursor_page_size = safe_int(
            cursor.get("limit"),
            configured_page_size,
        )

        limit = max(
            1,
            min(
                cursor_page_size,
                configured_page_size,
                self.batch_size,
                self.MAX_PAGE_SIZE,
            ),
        )

        parameters: dict[str, Any] = {
            "limit": limit,
            "offset": offset,
        }

        active_filters = self._configured_filters()

        for parameter, value in active_filters.items():
            parameters[parameter] = value

        request_count_before = self.http.requests

        payload = self.http.get_json(
            endpoint,
            parameters,
        )

        request_count = (
            self.http.requests
            - request_count_before
        )

        if request_count < 1:
            raise ProviderError(
                "GBIF provider completed without "
                "performing an HTTP request."
            )

        if not isinstance(
            payload,
            dict,
        ):
            raise ProviderError(
                "GBIF returned a non-object JSON response."
            )

        raw_results = payload.get(
            "results",
            [],
        )

        if not isinstance(
            raw_results,
            list,
        ):
            raise ProviderError(
                "GBIF response field `results` is not a list."
            )

        response_offset = safe_int(
            payload.get("offset"),
            offset,
        )

        response_limit = safe_int(
            payload.get("limit"),
            limit,
        )

        response_count = self._optional_int(
            payload.get("count")
        )

        end_of_records = bool(
            payload.get(
                "endOfRecords",
                len(raw_results) < limit,
            )
        )

        retrieved_at = now()

        crawl_metadata = {
            "endpoint": endpoint,
            "offset": response_offset,
            "limit": response_limit,
            "returned": len(raw_results),
            "count": response_count,
            "end_of_records": end_of_records,
            "filters": active_filters,
        }

        records: list[Taxon] = []

        for raw_record in raw_results:
            if not isinstance(
                raw_record,
                dict,
            ):
                continue

            record = self._normalize_record(
                raw_record=raw_record,
                base_url=base_url,
                retrieved_at=retrieved_at,
                crawl_metadata=crawl_metadata,
            )

            if record is not None:
                records.append(record)

        next_offset = (
            response_offset
            + len(raw_results)
        )

        if (
            not end_of_records
            and next_offset <= offset
        ):
            raise ProviderError(
                "GBIF returned no cursor progress while "
                "`endOfRecords` was false."
            )

        next_cursor = (
            None
            if end_of_records
            else self._encode_cursor(
                {
                    "offset": next_offset,
                    "limit": limit,
                    "endpoint": endpoint,
                    "filters": active_filters,
                }
            )
        )

        return Batch(
            records=records,
            next_cursor=next_cursor,
            exhausted=end_of_records,
            requests=request_count,
            raw=len(raw_results),
        )

    def _normalize_record(
        self,
        raw_record: dict[str, Any],
        base_url: str,
        retrieved_at: str,
        crawl_metadata: dict[str, Any],
    ) -> Taxon | None:
        """
        Normalize one GBIF result while retaining its complete raw payload.
        """

        provider_id = self._first_value(
            raw_record,
            "key",
            "usageKey",
            "taxonKey",
        )

        scientific_name = normalize_space(
            self._first_value(
                raw_record,
                "scientificName",
                "canonicalName",
                "species",
                "name",
            )
        )

        if (
            provider_id in (
                None,
                "",
            )
            or not scientific_name
        ):
            return None

        provider_key = str(
            provider_id
        )

        canonical_name = normalize_space(
            self._first_value(
                raw_record,
                "canonicalName",
                "species",
                "scientificName",
            )
        )

        if not canonical_name:
            canonical_name = scientific_name

        accepted_provider_id = normalize_space(
            self._first_value(
                raw_record,
                "acceptedKey",
                "acceptedUsageKey",
            )
        )

        if (
            accepted_provider_id
            == provider_key
        ):
            accepted_provider_id = ""

        source_url = normalize_space(
            self._first_value(
                raw_record,
                "references",
            )
        )

        if not source_url:
            source_url = (
                f"{base_url}/species/"
                f"{provider_key}"
            )

        source_modified = normalize_space(
            self._first_value(
                raw_record,
                "modified",
                "lastInterpreted",
            )
        )

        status = self._normalize_status(
            self._first_value(
                raw_record,
                "taxonomicStatus",
                "status",
            )
        )

        rank = normalize_space(
            self._first_value(
                raw_record,
                "rank",
                "taxonRank",
            )
        ).lower() or "unknown"

        synonyms = self._extract_synonyms(
            raw_record,
            scientific_name,
        )

        return Taxon(
            provider=self.name,
            provider_id=provider_key,
            scientific_name=scientific_name,
            canonical_name=canonical_name,
            rank=rank,
            status=status,
            authorship=normalize_space(
                self._first_value(
                    raw_record,
                    "authorship",
                    "scientificNameAuthorship",
                )
            ),
            kingdom=normalize_space(
                raw_record.get("kingdom")
            ),
            phylum=normalize_space(
                raw_record.get("phylum")
            ),
            class_name=normalize_space(
                raw_record.get("class")
            ),
            order=normalize_space(
                raw_record.get("order")
            ),
            family=normalize_space(
                raw_record.get("family")
            ),
            genus=normalize_space(
                raw_record.get("genus")
            ),
            accepted_provider_id=accepted_provider_id,
            source_url=source_url,
            source_modified=source_modified,
            retrieved_at=retrieved_at,
            synonyms=synonyms,
            extra={
                "source": "GBIF Species API",
                "endpoint": (
                    f"{base_url}/species/search"
                ),
                "provider_key": provider_key,
                "crawl": dict(
                    crawl_metadata
                ),
                "identifiers": {
                    "key": raw_record.get(
                        "key"
                    ),
                    "nub_key": raw_record.get(
                        "nubKey"
                    ),
                    "taxon_key": raw_record.get(
                        "taxonKey"
                    ),
                    "usage_key": raw_record.get(
                        "usageKey"
                    ),
                    "accepted_key": raw_record.get(
                        "acceptedKey"
                    ),
                    "parent_key": raw_record.get(
                        "parentKey"
                    ),
                    "kingdom_key": raw_record.get(
                        "kingdomKey"
                    ),
                    "phylum_key": raw_record.get(
                        "phylumKey"
                    ),
                    "class_key": raw_record.get(
                        "classKey"
                    ),
                    "order_key": raw_record.get(
                        "orderKey"
                    ),
                    "family_key": raw_record.get(
                        "familyKey"
                    ),
                    "genus_key": raw_record.get(
                        "genusKey"
                    ),
                    "subgenus_key": raw_record.get(
                        "subgenusKey"
                    ),
                    "species_key": raw_record.get(
                        "speciesKey"
                    ),
                    "name_key": raw_record.get(
                        "nameKey"
                    ),
                    "dataset_key": raw_record.get(
                        "datasetKey"
                    ),
                    "constituent_key": raw_record.get(
                        "constituentKey"
                    ),
                },
                "raw": raw_record,
            },
        )

    def _configured_filters(
        self,
    ) -> dict[str, Any]:
        """
        Read optional species-search filters from the provider definition.

        Registry keys and API keys are mapped explicitly so the provider can
        support aliases later without changing the registry format.
        """

        filters: dict[str, Any] = {}

        for (
            registry_key,
            api_parameter,
        ) in self.FILTER_PARAMETERS.items():
            value = self.definition.get(
                registry_key
            )

            if value in (
                None,
                "",
                [],
                {},
            ):
                continue

            filters[api_parameter] = value

        return filters

    @staticmethod
    def _normalize_status(
        value: Any,
    ) -> str:
        """Normalize GBIF taxonomic status values."""

        status = normalize_space(
            value
        ).casefold()

        aliases = {
            "accepted": "accepted",
            "doubtful": "unknown",
            "synonym": "synonym",
            "heterotypic synonym": "synonym",
            "homotypic synonym": "synonym",
            "proparte synonym": "synonym",
            "misapplied": "misapplied",
        }

        if status in aliases:
            return aliases[status]

        return status or "unknown"

    @classmethod
    def _extract_synonyms(
        cls,
        raw_record: dict[str, Any],
        scientific_name: str,
    ) -> list[str]:
        """
        Extract synonym-like names already present in the search response.

        No secondary GBIF synonym request is performed.
        """

        values: list[str] = []

        for key in (
            "synonym",
            "synonyms",
            "accepted",
            "acceptedName",
            "acceptedScientificName",
        ):
            raw_value = raw_record.get(
                key
            )

            if isinstance(
                raw_value,
                str,
            ):
                value = normalize_space(
                    raw_value
                )

                if value:
                    values.append(value)

            elif isinstance(
                raw_value,
                list,
            ):
                for item in raw_value:
                    if isinstance(
                        item,
                        str,
                    ):
                        value = normalize_space(
                            item
                        )

                    elif isinstance(
                        item,
                        dict,
                    ):
                        value = normalize_space(
                            cls._first_value(
                                item,
                                "scientificName",
                                "canonicalName",
                                "acceptedScientificName",
                                "name",
                            )
                        )

                    else:
                        value = ""

                    if value:
                        values.append(value)

        accepted_name = normalize_space(
            raw_record.get(
                "acceptedScientificName"
            )
        )

        if accepted_name:
            values.append(
                accepted_name
            )

        unique: list[str] = []
        seen: set[str] = {
            scientific_name.casefold()
        }

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

            seen.add(key)
            unique.append(
                normalized
            )

        return unique

    @staticmethod
    def _decode_cursor(
        cursor: str | None,
    ) -> dict[str, Any]:
        """
        Decode a structured cursor while supporting legacy numeric offsets.
        """

        if not cursor:
            return {}

        stripped = cursor.strip()

        if stripped.isdigit():
            return {
                "offset": int(
                    stripped
                )
            }

        try:
            decoded = json.loads(
                stripped
            )
        except (
            TypeError,
            json.JSONDecodeError,
        ):
            return {}

        if not isinstance(
            decoded,
            dict,
        ):
            return {}

        return decoded

    @staticmethod
    def _encode_cursor(
        cursor: dict[str, Any],
    ) -> str:
        """Encode provider state as deterministic compact JSON."""

        return json.dumps(
            cursor,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    @staticmethod
    def _first_value(
        record: dict[str, Any],
        *keys: str,
    ) -> Any:
        """Return the first nonempty value from the requested keys."""

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
    def _optional_int(
        value: Any,
    ) -> int | None:
        """Return an integer value or None without inventing a default."""

        if value in (
            None,
            "",
        ):
            return None

        try:
            return int(value)
        except (
            TypeError,
            ValueError,
        ):
            return None
