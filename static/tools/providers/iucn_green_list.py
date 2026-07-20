#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/iucn_green_list.py

IUCN Green List provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It does not assume access to an undocumented or
unlicensed public API.

The IUCN Green List primarily describes protected and conserved areas rather
than biological taxa. To keep the shared Speciedex provider contract intact,
each Green List site is emitted as a reference Taxon-like record with rank
``protected_area`` and the full site record preserved under
``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "iucn_green_list",
        "path": "static/data/providers/iucn/green-list.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "IUCN Green List",
        "source_url": "https://iucngreenlist.org/"
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
    """File-backed IUCN Green List provider."""

    PROVIDER_NAME = "iucn_green_list"

    DEFAULT_SOURCE_NAME = "IUCN Green List"
    DEFAULT_SOURCE_URL = "https://iucngreenlist.org/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable Green List JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"IUCN Green List export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"IUCN Green List path is not a file: {source_path}"
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
                "IUCN Green List provider requires a path."
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
        """Normalize one IUCN Green List site record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "site_id",
                "siteId",
                "green_list_id",
                "greenListId",
                "wdpa_id",
                "wdpaId",
                "id",
            )
        )

        site_name = normalize_space(
            self._first_value(
                raw,
                "site_name",
                "siteName",
                "name",
                "official_name",
                "officialName",
            )
        )

        if not provider_id or not site_name:
            return None

        status = self._normalize_listing_status(
            self._first_value(
                raw,
                "status",
                "listing_status",
                "listingStatus",
                "certification_status",
                "certificationStatus",
            )
        )

        source_url = normalize_space(
            self._first_value(
                raw,
                "url",
                "source_url",
                "sourceUrl",
                "profile_url",
                "profileUrl",
            )
        ) or normalize_space(
            self.definition.get(
                "source_url",
                self.DEFAULT_SOURCE_URL,
            )
        )

        country = normalize_space(
            self._first_value(
                raw,
                "country",
                "country_name",
                "countryName",
                "state_party",
                "stateParty",
            )
        )

        designation = normalize_space(
            self._first_value(
                raw,
                "designation",
                "designation_type",
                "designationType",
                "site_type",
                "siteType",
            )
        )

        return Taxon(
            provider=self.name,
            provider_id=provider_id,
            scientific_name=site_name,
            canonical_name=site_name,
            rank="protected_area",
            status="reference",
            authorship="",
            kingdom="",
            phylum="",
            class_name="",
            order="",
            family="",
            genus="",
            accepted_provider_id="",
            source_url=source_url,
            source_modified=normalize_space(
                self._first_value(
                    raw,
                    "modified",
                    "last_modified",
                    "lastModified",
                    "certification_date",
                    "certificationDate",
                    "assessment_date",
                    "assessmentDate",
                )
            ),
            retrieved_at=retrieved_at,
            synonyms=[],
            extra={
                "source": normalize_space(
                    self.definition.get(
                        "source_name",
                        self.DEFAULT_SOURCE_NAME,
                    )
                ) or self.DEFAULT_SOURCE_NAME,
                "iucn_program": "green_list",
                "reference_only": True,
                "entity_type": "protected_area",
                "site_id": provider_id,
                "site_name": site_name,
                "listing_status": status,
                "designation": designation,
                "country": country,
                "jurisdiction": normalize_space(
                    self._first_value(
                        raw,
                        "jurisdiction",
                        "region",
                        "province",
                        "state",
                    )
                ),
                "location": {
                    "latitude": self._optional_float(
                        self._first_value(
                            raw,
                            "latitude",
                            "lat",
                            "centroid_latitude",
                            "centroidLatitude",
                        )
                    ),
                    "longitude": self._optional_float(
                        self._first_value(
                            raw,
                            "longitude",
                            "lon",
                            "lng",
                            "centroid_longitude",
                            "centroidLongitude",
                        )
                    ),
                    "geometry": self._first_value(
                        raw,
                        "geometry",
                        "boundary",
                        "geojson",
                    ),
                },
                "area": {
                    "value": self._optional_float(
                        self._first_value(
                            raw,
                            "area",
                            "area_km2",
                            "areaKm2",
                            "reported_area",
                            "reportedArea",
                        )
                    ),
                    "unit": normalize_space(
                        self._first_value(
                            raw,
                            "area_unit",
                            "areaUnit",
                        )
                    ) or "km2",
                },
                "governance": {
                    "type": normalize_space(
                        self._first_value(
                            raw,
                            "governance_type",
                            "governanceType",
                        )
                    ),
                    "authority": normalize_space(
                        self._first_value(
                            raw,
                            "governance_authority",
                            "governanceAuthority",
                            "management_authority",
                            "managementAuthority",
                        )
                    ),
                    "owner": normalize_space(
                        self._first_value(
                            raw,
                            "owner",
                            "ownership",
                        )
                    ),
                },
                "management": {
                    "plan": normalize_space(
                        self._first_value(
                            raw,
                            "management_plan",
                            "managementPlan",
                        )
                    ),
                    "effectiveness": normalize_space(
                        self._first_value(
                            raw,
                            "management_effectiveness",
                            "managementEffectiveness",
                        )
                    ),
                    "agency": normalize_space(
                        self._first_value(
                            raw,
                            "management_agency",
                            "managementAgency",
                        )
                    ),
                },
                "certification": {
                    "status": status,
                    "date": normalize_space(
                        self._first_value(
                            raw,
                            "certification_date",
                            "certificationDate",
                        )
                    ),
                    "expiry_date": normalize_space(
                        self._first_value(
                            raw,
                            "expiry_date",
                            "expiryDate",
                            "valid_until",
                            "validUntil",
                        )
                    ),
                    "assessment_date": normalize_space(
                        self._first_value(
                            raw,
                            "assessment_date",
                            "assessmentDate",
                        )
                    ),
                    "assessor": normalize_space(
                        self._first_value(
                            raw,
                            "assessor",
                            "assessment_body",
                            "assessmentBody",
                        )
                    ),
                },
                "criteria": self._list_value(
                    self._first_value(
                        raw,
                        "criteria",
                        "green_list_criteria",
                        "greenListCriteria",
                    )
                ),
                "standards": self._list_value(
                    self._first_value(
                        raw,
                        "standards",
                        "standard",
                    )
                ),
                "conservation_values": self._list_value(
                    self._first_value(
                        raw,
                        "conservation_values",
                        "conservationValues",
                        "key_values",
                        "keyValues",
                    )
                ),
                "ecosystems": self._list_value(
                    self._first_value(
                        raw,
                        "ecosystems",
                        "ecosystem_types",
                        "ecosystemTypes",
                    )
                ),
                "species": self._list_value(
                    self._first_value(
                        raw,
                        "species",
                        "key_species",
                        "keySpecies",
                    )
                ),
                "threats": self._list_value(
                    self._first_value(
                        raw,
                        "threats",
                        "pressures",
                    )
                ),
                "outcomes": self._list_value(
                    self._first_value(
                        raw,
                        "outcomes",
                        "conservation_outcomes",
                        "conservationOutcomes",
                    )
                ),
                "wdpa_id": normalize_space(
                    self._first_value(
                        raw,
                        "wdpa_id",
                        "wdpaId",
                    )
                ),
                "bulk_source": source_path.as_posix(),
                "raw": raw,
            },
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
                f"Invalid IUCN Green List cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "IUCN Green List cursor must be non-negative."
            )

        return offset

    @staticmethod
    def _normalize_listing_status(
        value: Any,
    ) -> str:
        """Normalize common Green List listing and certification states."""

        status = normalize_space(
            value
        ).casefold()

        aliases = {
            "green listed": "green listed",
            "listed": "green listed",
            "certified": "green listed",
            "candidate": "candidate",
            "applicant": "applicant",
            "registered": "registered",
            "withdrawn": "withdrawn",
            "suspended": "suspended",
            "expired": "expired",
            "not listed": "not listed",
        }

        return aliases.get(
            status,
            status or "unknown",
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
    def _optional_float(
        value: Any,
    ) -> float | None:
        if value in (
            None,
            "",
        ):
            return None

        try:
            return float(
                value
            )
        except (
            TypeError,
            ValueError,
        ):
            return None
