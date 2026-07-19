#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/worms.py

World Register of Marine Species provider plug-in.

Fetches one page of WoRMS Aphia records with exactly one API request per
provider execution. No secondary per-record API requests are performed.

The complete provider record is preserved under Taxon.extra["raw"] while
principal taxonomic and nomenclatural fields are normalized for Speciedex.

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
    """World Register of Marine Species provider."""

    PROVIDER_NAME = "worms"

    DEFAULT_BASE_URL = (
        "https://www.marinespecies.org/rest"
    )

    DEFAULT_START_DATE = (
        "0001-01-01T00:00:00"
    )

    DEFAULT_END_DATE = (
        "9999-12-31T23:59:59"
    )

    DEFAULT_OFFSET = 1

    def fetch(self) -> Batch:
        """
        Fetch one WoRMS AphiaRecordsByDate page.

        Exactly one HTTP request is made. The cursor stores the next WoRMS
        offset value. All fields returned by WoRMS are retained in each
        normalized record's extra["raw"] object.
        """

        base_url = normalize_space(
            self.definition.get(
                "base_url",
                self.DEFAULT_BASE_URL,
            )
        ).rstrip("/")

        if not base_url:
            raise ProviderError(
                "WoRMS base_url is empty."
            )

        start_date = normalize_space(
            self.definition.get(
                "start_date",
                self.DEFAULT_START_DATE,
            )
        )

        end_date = normalize_space(
            self.definition.get(
                "end_date",
                self.DEFAULT_END_DATE,
            )
        )

        marine_only = self._boolean_parameter(
            self.definition.get(
                "marine_only",
                False,
            )
        )

        initial_offset = safe_int(
            self.definition.get(
                "start_offset",
                self.DEFAULT_OFFSET,
            ),
            self.DEFAULT_OFFSET,
        )

        offset = safe_int(
            self.cursor,
            initial_offset,
        )

        if offset < initial_offset:
            offset = initial_offset

        offset_increment = max(
            1,
            safe_int(
                self.definition.get(
                    "offset_increment",
                    1,
                ),
                1,
            ),
        )

        endpoint = (
            f"{base_url}/AphiaRecordsByDate"
        )

        parameters: dict[str, Any] = {
            "startdate": start_date,
            "enddate": end_date,
            "marine_only": marine_only,
            "offset": offset,
        }

        request_count_before = (
            self.http.requests
        )

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
                "WoRMS provider expected exactly one API "
                f"request but performed {request_count}."
            )

        if isinstance(payload, dict):
            api_error = self._extract_api_error(
                payload
            )

            if api_error:
                raise ProviderError(
                    f"WoRMS API error: {api_error}"
                )

            raw_records = self._extract_records(
                payload
            )

        elif isinstance(payload, list):
            raw_records = payload

        else:
            raise ProviderError(
                "WoRMS returned an unsupported JSON "
                "response type."
            )

        retrieved_at = now()
        records: list[Taxon] = []

        for raw_record in raw_records:
            if not isinstance(
                raw_record,
                dict,
            ):
                continue

            record = self._normalize_record(
                raw_record=raw_record,
                base_url=base_url,
                retrieved_at=retrieved_at,
            )

            if record is not None:
                records.append(record)

        exhausted = len(raw_records) == 0

        next_cursor = (
            None
            if exhausted
            else str(
                offset
                + offset_increment
            )
        )

        return Batch(
            records=records,
            next_cursor=next_cursor,
            exhausted=exhausted,
            requests=request_count,
            raw=len(raw_records),
        )

    def _normalize_record(
        self,
        raw_record: dict[str, Any],
        base_url: str,
        retrieved_at: str,
    ) -> Taxon | None:
        """Normalize one Aphia record without discarding source fields."""

        aphia_id = self._first_value(
            raw_record,
            "AphiaID",
            "aphiaID",
            "aphia_id",
            "id",
        )

        scientific_name = normalize_space(
            self._first_value(
                raw_record,
                "scientificname",
                "scientificName",
                "valid_name",
                "name",
            )
        )

        if (
            aphia_id in (
                None,
                "",
            )
            or not scientific_name
        ):
            return None

        provider_id = str(aphia_id)

        canonical_name = normalize_space(
            self._first_value(
                raw_record,
                "scientificname",
                "scientificName",
                "valid_name",
            )
        )

        if not canonical_name:
            canonical_name = scientific_name

        valid_aphia_id = normalize_space(
            self._first_value(
                raw_record,
                "valid_AphiaID",
                "validAphiaID",
                "accepted_AphiaID",
                "acceptedAphiaID",
            )
        )

        valid_name = normalize_space(
            self._first_value(
                raw_record,
                "valid_name",
                "validName",
                "accepted_name",
                "acceptedName",
            )
        )

        authority = normalize_space(
            self._first_value(
                raw_record,
                "authority",
                "authorship",
                "scientificNameAuthorship",
            )
        )

        rank = normalize_space(
            self._first_value(
                raw_record,
                "rank",
                "taxonRank",
            )
        ).lower()

        status = self._normalize_status(
            self._first_value(
                raw_record,
                "status",
                "taxonomicStatus",
            )
        )

        source_url = normalize_space(
            self._first_value(
                raw_record,
                "url",
                "lsid",
            )
        )

        if not source_url:
            source_url = (
                f"{base_url}/AphiaRecordByAphiaID/"
                f"{provider_id}"
            )

        source_modified = normalize_space(
            self._first_value(
                raw_record,
                "modified",
                "lastModified",
                "updated",
            )
        )

        synonyms: list[str] = []

        if (
            valid_name
            and valid_name.casefold()
            != scientific_name.casefold()
        ):
            synonyms.append(
                scientific_name
            )

        explicit_synonyms = self._extract_synonyms(
            raw_record
        )

        for synonym in explicit_synonyms:
            if (
                synonym.casefold()
                not in {
                    value.casefold()
                    for value in synonyms
                }
            ):
                synonyms.append(synonym)

        taxonomy = {
            "kingdom": normalize_space(
                raw_record.get("kingdom")
            ),
            "phylum": normalize_space(
                raw_record.get("phylum")
            ),
            "class": normalize_space(
                raw_record.get("class")
            ),
            "order": normalize_space(
                raw_record.get("order")
            ),
            "family": normalize_space(
                raw_record.get("family")
            ),
            "genus": normalize_space(
                raw_record.get("genus")
            ),
        }

        return Taxon(
            provider=self.name,
            provider_id=provider_id,
            scientific_name=scientific_name,
            canonical_name=canonical_name,
            rank=rank or "unknown",
            status=status,
            authorship=authority,
            kingdom=taxonomy["kingdom"],
            phylum=taxonomy["phylum"],
            class_name=taxonomy["class"],
            order=taxonomy["order"],
            family=taxonomy["family"],
            genus=taxonomy["genus"],
            accepted_provider_id=valid_aphia_id,
            source_url=source_url,
            source_modified=source_modified,
            retrieved_at=retrieved_at,
            synonyms=synonyms,
            extra={
                "source": (
                    "World Register of Marine Species"
                ),
                "endpoint": (
                    f"{base_url}/AphiaRecordsByDate"
                ),
                "aphia_id": provider_id,
                "valid_aphia_id": valid_aphia_id,
                "valid_name": valid_name,
                "lsid": normalize_space(
                    raw_record.get("lsid")
                ),
                "citation": normalize_space(
                    raw_record.get("citation")
                ),
                "match_type": normalize_space(
                    self._first_value(
                        raw_record,
                        "match_type",
                        "matchType",
                    )
                ),
                "unaccept_reason": normalize_space(
                    self._first_value(
                        raw_record,
                        "unacceptreason",
                        "unaccept_reason",
                        "unacceptedReason",
                    )
                ),
                "is_marine": self._boolean_value(
                    self._first_value(
                        raw_record,
                        "isMarine",
                        "is_marine",
                    )
                ),
                "is_brackish": self._boolean_value(
                    self._first_value(
                        raw_record,
                        "isBrackish",
                        "is_brackish",
                    )
                ),
                "is_freshwater": self._boolean_value(
                    self._first_value(
                        raw_record,
                        "isFreshwater",
                        "is_freshwater",
                    )
                ),
                "is_terrestrial": self._boolean_value(
                    self._first_value(
                        raw_record,
                        "isTerrestrial",
                        "is_terrestrial",
                    )
                ),
                "is_extinct": self._boolean_value(
                    self._first_value(
                        raw_record,
                        "isExtinct",
                        "is_extinct",
                    )
                ),
                "is_fossil": self._boolean_value(
                    self._first_value(
                        raw_record,
                        "isFossil",
                        "is_fossil",
                    )
                ),
                "taxonomy": taxonomy,
                "parent_name_usage": normalize_space(
                    self._first_value(
                        raw_record,
                        "parent_name_usage",
                        "parentNameUsage",
                    )
                ),
                "parent_aphia_id": normalize_space(
                    self._first_value(
                        raw_record,
                        "parent_AphiaID",
                        "parentAphiaID",
                    )
                ),
                "child_count": self._integer_value(
                    self._first_value(
                        raw_record,
                        "childCount",
                        "child_count",
                    )
                ),
                "modified": source_modified,
                "raw": raw_record,
            },
        )

    @staticmethod
    def _extract_records(
        payload: dict[str, Any],
    ) -> list[Any]:
        """
        Extract records when an installation wraps the list in an object.

        The public endpoint normally returns a list directly, but accepting
        common wrapper keys keeps the provider tolerant of mirrors or proxies.
        """

        for key in (
            "records",
            "results",
            "data",
            "taxa",
        ):
            value = payload.get(key)

            if isinstance(value, list):
                return value

        return []

    @classmethod
    def _extract_synonyms(
        cls,
        raw_record: dict[str, Any],
    ) -> list[str]:
        """Extract synonym names already present in the returned record."""

        values: list[str] = []

        for key in (
            "synonym",
            "synonyms",
            "unaccepted_names",
            "unacceptedNames",
        ):
            value = raw_record.get(key)

            if isinstance(value, str):
                normalized = normalize_space(
                    value
                )

                if normalized:
                    values.append(
                        normalized
                    )

            elif isinstance(value, list):
                for item in value:
                    if isinstance(item, str):
                        normalized = normalize_space(
                            item
                        )

                    elif isinstance(item, dict):
                        normalized = normalize_space(
                            cls._first_value(
                                item,
                                "scientificname",
                                "scientificName",
                                "valid_name",
                                "name",
                            )
                        )

                    else:
                        normalized = ""

                    if normalized:
                        values.append(
                            normalized
                        )

        unique: list[str] = []
        seen: set[str] = set()

        for value in values:
            key = value.casefold()

            if key in seen:
                continue

            seen.add(key)
            unique.append(value)

        return unique

    @staticmethod
    def _normalize_status(
        value: Any,
    ) -> str:
        """Normalize WoRMS status values for Speciedex."""

        status = normalize_space(
            value
        ).casefold()

        aliases = {
            "accepted": "accepted",
            "unaccepted": "synonym",
            "alternate representation": "accepted",
            "temporary name": "provisionally accepted",
            "uncertain": "unknown",
            "quarantined": "unknown",
        }

        if status in aliases:
            return aliases[status]

        for source, target in aliases.items():
            if source in status:
                return target

        return status or "unknown"

    @staticmethod
    def _extract_api_error(
        payload: dict[str, Any],
    ) -> str:
        """Extract a readable API error from object responses."""

        for key in (
            "error",
            "message",
            "detail",
            "description",
        ):
            value = payload.get(key)

            if isinstance(value, str):
                normalized = normalize_space(
                    value
                )

                if normalized:
                    return normalized

            if isinstance(value, dict):
                for child_key in (
                    "message",
                    "detail",
                    "description",
                    "error",
                ):
                    normalized = normalize_space(
                        value.get(child_key)
                    )

                    if normalized:
                        return normalized

        return ""

    @staticmethod
    def _first_value(
        record: dict[str, Any],
        *keys: str,
    ) -> Any:
        """Return the first nonempty value under the requested keys."""

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
    def _boolean_parameter(
        value: Any,
    ) -> str:
        """Convert a configured boolean to the WoRMS query representation."""

        if isinstance(value, bool):
            return (
                "true"
                if value
                else "false"
            )

        normalized = normalize_space(
            value
        ).casefold()

        return (
            "true"
            if normalized in {
                "1",
                "true",
                "yes",
                "on",
            }
            else "false"
        )

    @staticmethod
    def _boolean_value(
        value: Any,
    ) -> bool | None:
        """Normalize WoRMS boolean-like values without inventing a value."""

        if isinstance(value, bool):
            return value

        if isinstance(value, int):
            return bool(value)

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

    @staticmethod
    def _integer_value(
        value: Any,
    ) -> int | None:
        """Convert an optional integer-like value."""

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
