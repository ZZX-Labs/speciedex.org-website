#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/gbif.py

GBIF provider plug-in.

Fetches one page of GBIF taxonomic records with one API request per run.
Every field returned for each GBIF record is retained in the raw provider
payload while core taxonomic fields are normalized for reconciliation.

Copyright (c) 2026 ZZX-Laboratories

Licensed under the MIT License.
"""

from __future__ import annotations

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
    """GBIF taxonomic provider."""

    PROVIDER_NAME = "gbif"

    DEFAULT_BASE_URL = "https://api.gbif.org/v1"
    MAX_PAGE_SIZE = 1000

    def fetch(self) -> Batch:
        """
        Fetch one complete GBIF species-search page.

        This method performs exactly one API request. It does not make
        secondary record, vernacular-name, media, occurrence, or reference
        requests.

        All information returned for each record by the species/search
        endpoint is retained in Taxon.extra["raw"].
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

        offset = safe_int(
            self.cursor,
            safe_int(
                self.definition.get(
                    "start_offset",
                    0,
                ),
                0,
            ),
        )

        configured_limit = safe_int(
            self.definition.get(
                "page_size",
                self.batch_size,
            ),
            self.batch_size,
        )

        limit = max(
            1,
            min(
                configured_limit,
                self.batch_size,
                self.MAX_PAGE_SIZE,
            ),
        )

        endpoint = f"{base_url}/species/search"

        parameters: dict[str, Any] = {
            "limit": limit,
            "offset": offset,
        }

        for parameter in (
            "q",
            "rank",
            "highertaxon_key",
            "status",
            "is_extinct",
            "habitat",
            "name_type",
            "nomenclatural_status",
            "issue",
            "dataset_key",
            "origin",
        ):
            configured_value = self.definition.get(
                parameter
            )

            if configured_value not in (
                None,
                "",
                [],
            ):
                parameters[parameter] = configured_value

        request_count_before = self.http.requests

        payload = self.http.get_json(
            endpoint,
            parameters,
        )

        request_count = (
            self.http.requests
            - request_count_before
        )

        if request_count != 1:
            raise ProviderError(
                "GBIF provider expected exactly one API "
                f"request but performed {request_count}."
            )

        if not isinstance(payload, dict):
            raise ProviderError(
                "GBIF returned a non-object JSON response."
            )

        raw_results = payload.get(
            "results",
            [],
        )

        if not isinstance(raw_results, list):
            raise ProviderError(
                "GBIF response field `results` is not a list."
            )

        retrieved_at = now()
        records: list[Taxon] = []

        for raw_record in raw_results:
            if not isinstance(raw_record, dict):
                continue

            record = self._normalize_record(
                raw_record,
                base_url,
                retrieved_at,
            )

            if record is not None:
                records.append(record)

        end_of_records = bool(
            payload.get(
                "endOfRecords",
                len(raw_results) < limit,
            )
        )

        next_offset = offset + len(raw_results)

        if (
            not end_of_records
            and next_offset <= offset
        ):
            raise ProviderError(
                "GBIF returned no cursor progress while "
                "endOfRecords was false."
            )

        next_cursor = (
            None
            if end_of_records
            else str(next_offset)
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
    ) -> Taxon | None:
        """Normalize one GBIF result while preserving its full payload."""

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

        provider_key = str(provider_id)

        source_url = normalize_space(
            self._first_value(
                raw_record,
                "references",
            )
        )

        if not source_url:
            source_url = (
                f"{base_url}/species/{provider_key}"
            )

        source_modified = normalize_space(
            self._first_value(
                raw_record,
                "modified",
                "lastInterpreted",
            )
        )

        synonyms = self._extract_synonyms(
            raw_record
        )

        return Taxon(
            provider=self.name,
            provider_id=provider_key,
            scientific_name=scientific_name,
            canonical_name=canonical_name,
            rank=normalize_space(
                self._first_value(
                    raw_record,
                    "rank",
                    "taxonRank",
                )
            ).lower() or "unknown",
            status=normalize_space(
                self._first_value(
                    raw_record,
                    "taxonomicStatus",
                    "status",
                )
            ).lower() or "unknown",
            authorship=normalize_space(
                self._first_value(
                    raw_record,
                    "authorship",
                    "scientificNameAuthorship",
                )
            ),
            kingdom=normalize_space(
                self._first_value(
                    raw_record,
                    "kingdom",
                )
            ),
            phylum=normalize_space(
                self._first_value(
                    raw_record,
                    "phylum",
                )
            ),
            class_name=normalize_space(
                self._first_value(
                    raw_record,
                    "class",
                )
            ),
            order=normalize_space(
                self._first_value(
                    raw_record,
                    "order",
                )
            ),
            family=normalize_space(
                self._first_value(
                    raw_record,
                    "family",
                )
            ),
            genus=normalize_space(
                self._first_value(
                    raw_record,
                    "genus",
                )
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
                "gbif_key": provider_key,
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
                "parent": normalize_space(
                    raw_record.get("parent")
                ),
                "subgenus": normalize_space(
                    raw_record.get("subgenus")
                ),
                "species": normalize_space(
                    raw_record.get("species")
                ),
                "specific_epithet": normalize_space(
                    raw_record.get(
                        "specificEpithet"
                    )
                ),
                "infraspecific_epithet": normalize_space(
                    raw_record.get(
                        "infraspecificEpithet"
                    )
                ),
                "name_type": raw_record.get(
                    "nameType"
                ),
                "origin": raw_record.get(
                    "origin"
                ),
                "nomenclatural_status": (
                    raw_record.get(
                        "nomenclaturalStatus"
                    )
                ),
                "nomenclatural_code": raw_record.get(
                    "nomenclaturalCode"
                ),
                "published_in": normalize_space(
                    raw_record.get(
                        "publishedIn"
                    )
                ),
                "according_to": normalize_space(
                    raw_record.get(
                        "accordingTo"
                    )
                ),
                "last_interpreted": raw_record.get(
                    "lastInterpreted"
                ),
                "num_descendants": raw_record.get(
                    "numDescendants"
                ),
                "is_extinct": raw_record.get(
                    "extinct"
                ),
                "issues": self._list_value(
                    raw_record.get("issues")
                ),
                "vernacular_names": self._list_value(
                    raw_record.get(
                        "vernacularNames"
                    )
                ),
                "descriptions": self._list_value(
                    raw_record.get(
                        "descriptions"
                    )
                ),
                "media": self._list_value(
                    raw_record.get("media")
                ),
                "raw": raw_record,
            },
        )

    @staticmethod
    def _first_value(
        record: dict[str, Any],
        *keys: str,
    ) -> Any:
        """Return the first nonempty value from the requested keys."""

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
        """Normalize an optional value to a list without losing data."""

        if value is None:
            return []

        if isinstance(value, list):
            return value

        return [value]

    @classmethod
    def _extract_synonyms(
        cls,
        raw_record: dict[str, Any],
    ) -> list[str]:
        """Extract synonym names available in the search response."""

        values: list[str] = []

        for key in (
            "synonym",
            "synonyms",
            "accepted",
            "acceptedScientificName",
        ):
            raw_value = raw_record.get(key)

            if isinstance(raw_value, str):
                value = normalize_space(
                    raw_value
                )

                if value:
                    values.append(value)

            elif isinstance(raw_value, list):
                for item in raw_value:
                    if isinstance(item, str):
                        value = normalize_space(item)
                    elif isinstance(item, dict):
                        value = normalize_space(
                            cls._first_value(
                                item,
                                "scientificName",
                                "canonicalName",
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
            values.append(accepted_name)

        unique: list[str] = []
        seen: set[str] = set()

        for value in values:
            key = value.casefold()

            if key in seen:
                continue

            seen.add(key)
            unique.append(value)

        return unique
