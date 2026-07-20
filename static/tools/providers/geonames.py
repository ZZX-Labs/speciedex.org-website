#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/geonames.py

GeoNames provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It is intended for geographic authority data used by
Speciedex to normalize countries, regions, administrative divisions, populated
places, water bodies, protected areas, islands, mountains, and other locality
records associated with biodiversity data.

GeoNames is not a taxonomic authority. Records are represented through the
shared Taxon contract as reference-oriented geographic entities, while the
complete GeoNames source object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "geonames",
        "path": "static/data/providers/geonames/records.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "GeoNames",
        "source_url": "https://www.geonames.org/"
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
    """File-backed GeoNames provider."""

    PROVIDER_NAME = "geonames"

    DEFAULT_SOURCE_NAME = "GeoNames"
    DEFAULT_SOURCE_URL = "https://www.geonames.org/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable GeoNames JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"GeoNames export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"GeoNames path is not a file: {source_path}"
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
                            f"Invalid GeoNames JSON at "
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
        """Resolve the configured GeoNames JSONL source path."""

        configured = normalize_space(
            self.definition.get("path")
            or self.definition.get("file")
            or self.definition.get("source_path")
        )

        if not configured:
            raise ProviderError(
                "GeoNames provider requires a path."
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
        """Normalize one GeoNames geographic record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "geoname_id",
                "geonameId",
                "geonameid",
                "id",
            )
        )

        name = normalize_space(
            self._first_value(
                raw,
                "name",
                "toponym_name",
                "toponymName",
                "ascii_name",
                "asciiName",
            )
        )

        if not provider_id or not name:
            return None

        canonical_name = normalize_space(
            self._first_value(
                raw,
                "ascii_name",
                "asciiName",
                "canonical_name",
                "canonicalName",
            )
        ) or name

        feature_class = normalize_space(
            self._first_value(
                raw,
                "feature_class",
                "featureClass",
                "fcl",
            )
        ).upper()

        feature_code = normalize_space(
            self._first_value(
                raw,
                "feature_code",
                "featureCode",
                "fcode",
            )
        ).upper()

        rank = self._rank_from_feature(
            feature_class,
            feature_code,
        )

        source_url = normalize_space(
            self._first_value(
                raw,
                "url",
                "source_url",
                "sourceUrl",
                "record_url",
                "recordUrl",
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
                + "/"
                + provider_id
            )

        parent_id = normalize_space(
            self._first_value(
                raw,
                "parent_id",
                "parentId",
                "parent_geoname_id",
                "parentGeonameId",
            )
        )

        hierarchy = self._normalize_hierarchy(
            self._first_value(
                raw,
                "hierarchy",
                "administrative_hierarchy",
                "administrativeHierarchy",
                "ancestors",
            )
        )

        return Taxon(
            provider=self.name,
            provider_id=provider_id,
            scientific_name=name,
            canonical_name=canonical_name,
            rank=rank,
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
                    "modification_date",
                    "modificationDate",
                    "modified",
                    "updated",
                    "updated_at",
                    "updatedAt",
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
                "programme": "geonames",
                "reference_only": True,
                "geoname_id": provider_id,
                "entity_type": "geographic_feature",
                "feature": {
                    "feature_class": feature_class,
                    "feature_code": feature_code,
                    "feature_class_name": normalize_space(
                        self._first_value(
                            raw,
                            "feature_class_name",
                            "featureClassName",
                            "fclName",
                        )
                    ),
                    "feature_code_name": normalize_space(
                        self._first_value(
                            raw,
                            "feature_code_name",
                            "featureCodeName",
                            "fcodeName",
                        )
                    ),
                    "continent_code": normalize_space(
                        self._first_value(
                            raw,
                            "continent_code",
                            "continentCode",
                        )
                    ),
                },
                "names": {
                    "name": name,
                    "ascii_name": normalize_space(
                        self._first_value(
                            raw,
                            "ascii_name",
                            "asciiName",
                        )
                    ),
                    "toponym_name": normalize_space(
                        self._first_value(
                            raw,
                            "toponym_name",
                            "toponymName",
                        )
                    ),
                    "alternate_names": self._normalize_alternate_names(
                        self._first_value(
                            raw,
                            "alternate_names",
                            "alternateNames",
                            "alternatenames",
                        )
                    ),
                },
                "coordinates": {
                    "latitude": self._optional_float(
                        self._first_value(
                            raw,
                            "latitude",
                            "lat",
                        )
                    ),
                    "longitude": self._optional_float(
                        self._first_value(
                            raw,
                            "longitude",
                            "lng",
                            "lon",
                        )
                    ),
                    "elevation_m": self._optional_float(
                        self._first_value(
                            raw,
                            "elevation",
                            "elevation_m",
                            "elevationM",
                        )
                    ),
                    "dem_elevation_m": self._optional_float(
                        self._first_value(
                            raw,
                            "dem",
                            "dem_elevation",
                            "demElevation",
                        )
                    ),
                    "accuracy_radius_km": self._optional_float(
                        self._first_value(
                            raw,
                            "accuracy_radius_km",
                            "accuracyRadiusKm",
                        )
                    ),
                },
                "administrative": {
                    "country_code": normalize_space(
                        self._first_value(
                            raw,
                            "country_code",
                            "countryCode",
                        )
                    ).upper(),
                    "country_name": normalize_space(
                        self._first_value(
                            raw,
                            "country_name",
                            "countryName",
                            "country",
                        )
                    ),
                    "country_geoname_id": normalize_space(
                        self._first_value(
                            raw,
                            "country_geoname_id",
                            "countryGeonameId",
                        )
                    ),
                    "admin1_code": normalize_space(
                        self._first_value(
                            raw,
                            "admin1_code",
                            "admin1Code",
                        )
                    ),
                    "admin1_name": normalize_space(
                        self._first_value(
                            raw,
                            "admin1_name",
                            "admin1Name",
                        )
                    ),
                    "admin1_geoname_id": normalize_space(
                        self._first_value(
                            raw,
                            "admin1_geoname_id",
                            "admin1GeonameId",
                        )
                    ),
                    "admin2_code": normalize_space(
                        self._first_value(
                            raw,
                            "admin2_code",
                            "admin2Code",
                        )
                    ),
                    "admin2_name": normalize_space(
                        self._first_value(
                            raw,
                            "admin2_name",
                            "admin2Name",
                        )
                    ),
                    "admin2_geoname_id": normalize_space(
                        self._first_value(
                            raw,
                            "admin2_geoname_id",
                            "admin2GeonameId",
                        )
                    ),
                    "admin3_code": normalize_space(
                        self._first_value(
                            raw,
                            "admin3_code",
                            "admin3Code",
                        )
                    ),
                    "admin3_name": normalize_space(
                        self._first_value(
                            raw,
                            "admin3_name",
                            "admin3Name",
                        )
                    ),
                    "admin3_geoname_id": normalize_space(
                        self._first_value(
                            raw,
                            "admin3_geoname_id",
                            "admin3GeonameId",
                        )
                    ),
                    "admin4_code": normalize_space(
                        self._first_value(
                            raw,
                            "admin4_code",
                            "admin4Code",
                        )
                    ),
                    "admin4_name": normalize_space(
                        self._first_value(
                            raw,
                            "admin4_name",
                            "admin4Name",
                        )
                    ),
                    "admin4_geoname_id": normalize_space(
                        self._first_value(
                            raw,
                            "admin4_geoname_id",
                            "admin4GeonameId",
                        )
                    ),
                    "parent_geoname_id": parent_id,
                    "hierarchy": hierarchy,
                },
                "country": {
                    "iso_alpha2": normalize_space(
                        self._first_value(
                            raw,
                            "country_code",
                            "countryCode",
                            "iso_alpha2",
                            "isoAlpha2",
                        )
                    ).upper(),
                    "iso_alpha3": normalize_space(
                        self._first_value(
                            raw,
                            "iso_alpha3",
                            "isoAlpha3",
                        )
                    ).upper(),
                    "iso_numeric": normalize_space(
                        self._first_value(
                            raw,
                            "iso_numeric",
                            "isoNumeric",
                        )
                    ),
                    "fips_code": normalize_space(
                        self._first_value(
                            raw,
                            "fips_code",
                            "fipsCode",
                        )
                    ),
                    "capital": normalize_space(
                        self._first_value(
                            raw,
                            "capital",
                        )
                    ),
                    "currency_code": normalize_space(
                        self._first_value(
                            raw,
                            "currency_code",
                            "currencyCode",
                        )
                    ),
                    "languages": self._list_value(
                        self._first_value(
                            raw,
                            "languages",
                            "language_codes",
                            "languageCodes",
                        )
                    ),
                },
                "population": {
                    "population": self._optional_int(
                        self._first_value(
                            raw,
                            "population",
                        )
                    ),
                    "population_date": normalize_space(
                        self._first_value(
                            raw,
                            "population_date",
                            "populationDate",
                        )
                    ),
                },
                "timezone": {
                    "timezone_id": normalize_space(
                        self._first_value(
                            raw,
                            "timezone_id",
                            "timezoneId",
                            "timezone",
                            "time_zone",
                            "timeZone",
                        )
                    ),
                    "gmt_offset": self._optional_float(
                        self._first_value(
                            raw,
                            "gmt_offset",
                            "gmtOffset",
                        )
                    ),
                    "dst_offset": self._optional_float(
                        self._first_value(
                            raw,
                            "dst_offset",
                            "dstOffset",
                        )
                    ),
                    "raw_offset": self._optional_float(
                        self._first_value(
                            raw,
                            "raw_offset",
                            "rawOffset",
                        )
                    ),
                },
                "postal_codes": self._normalize_postal_codes(
                    self._first_value(
                        raw,
                        "postal_codes",
                        "postalCodes",
                        "postal_code",
                        "postalCode",
                    )
                ),
                "nearby_features": self._normalize_nearby(
                    self._first_value(
                        raw,
                        "nearby_features",
                        "nearbyFeatures",
                        "nearby",
                    )
                ),
                "bbox": {
                    "north": self._optional_float(
                        self._first_value(
                            raw,
                            "north",
                            "bbox_north",
                            "bboxNorth",
                        )
                    ),
                    "south": self._optional_float(
                        self._first_value(
                            raw,
                            "south",
                            "bbox_south",
                            "bboxSouth",
                        )
                    ),
                    "east": self._optional_float(
                        self._first_value(
                            raw,
                            "east",
                            "bbox_east",
                            "bboxEast",
                        )
                    ),
                    "west": self._optional_float(
                        self._first_value(
                            raw,
                            "west",
                            "bbox_west",
                            "bboxWest",
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
                "links": self._normalize_links(
                    self._first_value(
                        raw,
                        "links",
                        "link",
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
    def _normalize_alternate_names(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize alternate geographic names."""

        result: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                name = normalize_space(
                    cls._first_value(
                        item,
                        "name",
                        "alternate_name",
                        "alternateName",
                        "value",
                    )
                )
                language = normalize_space(
                    cls._first_value(
                        item,
                        "language",
                        "lang",
                        "iso_language",
                        "isoLanguage",
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
                short_name = cls._optional_bool(
                    cls._first_value(
                        item,
                        "short",
                        "short_name",
                        "shortName",
                        "is_short_name",
                        "isShortName",
                    )
                )
                colloquial = cls._optional_bool(
                    cls._first_value(
                        item,
                        "colloquial",
                        "is_colloquial",
                        "isColloquial",
                    )
                )
                historic = cls._optional_bool(
                    cls._first_value(
                        item,
                        "historic",
                        "is_historic",
                        "isHistoric",
                    )
                )
                raw_item = dict(item)
            else:
                name = normalize_space(item)
                language = ""
                preferred = None
                short_name = None
                colloquial = None
                historic = None
                raw_item = item

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
                    "short_name": short_name,
                    "colloquial": colloquial,
                    "historic": historic,
                    "raw": raw_item,
                }
            )

        return result

    @classmethod
    def _normalize_hierarchy(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize parent and ancestor geographic hierarchy."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                entry = dict(item)
                entry.update(
                    {
                        "geoname_id": normalize_space(
                            cls._first_value(
                                item,
                                "geoname_id",
                                "geonameId",
                                "id",
                            )
                        ),
                        "name": normalize_space(
                            cls._first_value(
                                item,
                                "name",
                                "toponym_name",
                                "toponymName",
                            )
                        ),
                        "feature_class": normalize_space(
                            cls._first_value(
                                item,
                                "feature_class",
                                "featureClass",
                                "fcl",
                            )
                        ),
                        "feature_code": normalize_space(
                            cls._first_value(
                                item,
                                "feature_code",
                                "featureCode",
                                "fcode",
                            )
                        ),
                    }
                )

                if entry.get("geoname_id") or entry.get("name"):
                    result.append(entry)
            else:
                name = normalize_space(item)

                if name:
                    result.append(
                        {
                            "geoname_id": "",
                            "name": name,
                            "feature_class": "",
                            "feature_code": "",
                        }
                    )

        return result

    @classmethod
    def _normalize_postal_codes(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize postal-code associations."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                code = normalize_space(
                    cls._first_value(
                        item,
                        "postal_code",
                        "postalCode",
                        "code",
                    )
                )
                place_name = normalize_space(
                    cls._first_value(
                        item,
                        "place_name",
                        "placeName",
                        "name",
                    )
                )
                country_code = normalize_space(
                    cls._first_value(
                        item,
                        "country_code",
                        "countryCode",
                    )
                )
                raw_item = dict(item)
            else:
                code = normalize_space(item)
                place_name = ""
                country_code = ""
                raw_item = item

            if code:
                result.append(
                    {
                        "postal_code": code,
                        "place_name": place_name,
                        "country_code": country_code,
                        "raw": raw_item,
                    }
                )

        return result

    @classmethod
    def _normalize_nearby(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize nearby geographic features."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if not isinstance(item, Mapping):
                continue

            result.append(
                {
                    "geoname_id": normalize_space(
                        cls._first_value(
                            item,
                            "geoname_id",
                            "geonameId",
                            "id",
                        )
                    ),
                    "name": normalize_space(
                        cls._first_value(
                            item,
                            "name",
                            "toponym_name",
                            "toponymName",
                        )
                    ),
                    "feature_class": normalize_space(
                        cls._first_value(
                            item,
                            "feature_class",
                            "featureClass",
                            "fcl",
                        )
                    ),
                    "feature_code": normalize_space(
                        cls._first_value(
                            item,
                            "feature_code",
                            "featureCode",
                            "fcode",
                        )
                    ),
                    "distance_km": cls._optional_float(
                        cls._first_value(
                            item,
                            "distance",
                            "distance_km",
                            "distanceKm",
                        )
                    ),
                    "latitude": cls._optional_float(
                        cls._first_value(
                            item,
                            "latitude",
                            "lat",
                        )
                    ),
                    "longitude": cls._optional_float(
                        cls._first_value(
                            item,
                            "longitude",
                            "lng",
                            "lon",
                        )
                    ),
                    "raw": dict(item),
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
        """Normalize GeoNames and external identifiers."""

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
            "geoname_id": "GeoNames",
            "geonameId": "GeoNames",
            "geonameid": "GeoNames",
            "wikidata_id": "Wikidata",
            "wikidataId": "Wikidata",
            "osm_id": "OpenStreetMap",
            "osmId": "OpenStreetMap",
            "gnis_id": "GNIS",
            "gnisId": "GNIS",
            "geonames_country_id": "GeoNames Country",
            "geonamesCountryId": "GeoNames Country",
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
    def _normalize_links(
        cls,
        value: Any,
    ) -> list[dict[str, str]]:
        """Normalize external geographic links."""

        result: list[dict[str, str]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                url = normalize_space(
                    cls._first_value(
                        item,
                        "url",
                        "href",
                        "link",
                    )
                )
                relation = normalize_space(
                    cls._first_value(
                        item,
                        "relation",
                        "rel",
                        "type",
                    )
                )
            else:
                url = normalize_space(item)
                relation = ""

            if url:
                result.append(
                    {
                        "url": url,
                        "relation": relation,
                    }
                )

        return result

    @staticmethod
    def _rank_from_feature(
        feature_class: str,
        feature_code: str,
    ) -> str:
        """Map GeoNames feature codes into geographic entity ranks."""

        code = feature_code.upper()
        feature = feature_class.upper()

        if code == "CONT":
            return "continent"

        if code in {"PCLI", "PCLD", "PCLF", "PCLIX", "TERR"}:
            return "country"

        if code.startswith("ADM1"):
            return "administrative_division_1"

        if code.startswith("ADM2"):
            return "administrative_division_2"

        if code.startswith("ADM3"):
            return "administrative_division_3"

        if code.startswith("ADM4"):
            return "administrative_division_4"

        if code.startswith("ADM5"):
            return "administrative_division_5"

        if feature == "P":
            return "populated_place"

        if feature == "H":
            return "hydrographic_feature"

        if feature == "T":
            return "terrain_feature"

        if feature == "V":
            return "vegetation_feature"

        if feature == "L":
            return "area"

        if feature == "S":
            return "site"

        if feature == "R":
            return "road_or_rail_feature"

        if feature == "U":
            return "undersea_feature"

        return "geographic_feature"

    @staticmethod
    def _decode_cursor(cursor: str | None) -> int:
        """Decode a non-negative JSONL record offset."""

        if not cursor:
            return 0

        try:
            offset = int(cursor)
        except (TypeError, ValueError) as error:
            raise ProviderError(
                f"Invalid GeoNames cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "GeoNames cursor must be non-negative."
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

        if isinstance(value, str) and "," in value:
            return [
                part.strip()
                for part in value.split(",")
                if part.strip()
            ]

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
