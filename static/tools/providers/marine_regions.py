#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/marine_regions.py

Marine Regions provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It is intended for Marine Regions Gazetteer records,
Marine Regions Geographic Identifiers (MRGIDs), geographic names, alternate
names, place types, coordinates, polygons, maritime boundaries, Exclusive
Economic Zones (EEZs), marine ecoregions, oceans, seas, parent hierarchies,
references, external identifiers, and provenance metadata.

Marine Regions is a geographic authority rather than a taxonomic authority.
Records are represented through the shared Speciedex Taxon contract as
reference-oriented marine geographic entities. The complete source object is
preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "marine_regions",
        "path": "static/data/providers/marine-regions/records.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "Marine Regions",
        "source_url": "https://www.marineregions.org/"
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
    """File-backed Marine Regions provider."""

    PROVIDER_NAME = "marine_regions"

    DEFAULT_SOURCE_NAME = "Marine Regions"
    DEFAULT_SOURCE_URL = "https://www.marineregions.org/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable Marine Regions JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"Marine Regions export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"Marine Regions path is not a file: {source_path}"
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
                            f"Invalid Marine Regions JSON at "
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
        """Resolve the configured Marine Regions JSONL source path."""

        configured = normalize_space(
            self.definition.get("path")
            or self.definition.get("file")
            or self.definition.get("source_path")
        )

        if not configured:
            raise ProviderError(
                "Marine Regions provider requires a path."
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
        """Normalize one Marine Regions geographic record."""

        provider_id = normalize_space(
            self._first_value(
                raw,
                "mrgid",
                "MRGID",
                "marine_region_id",
                "marineRegionId",
                "gazetteer_id",
                "gazetteerId",
                "id",
            )
        )

        name = normalize_space(
            self._first_value(
                raw,
                "preferred_gazetteer_name",
                "preferredGazetteerName",
                "preferred_name",
                "preferredName",
                "gazetteer_name",
                "gazetteerName",
                "name",
            )
        )

        if not provider_id or not name:
            return None

        canonical_name = normalize_space(
            self._first_value(
                raw,
                "canonical_name",
                "canonicalName",
                "preferred_name",
                "preferredName",
                "ascii_name",
                "asciiName",
            )
        ) or name

        place_type = normalize_space(
            self._first_value(
                raw,
                "place_type",
                "placeType",
                "place_type_name",
                "placeTypeName",
                "type",
                "feature_type",
                "featureType",
            )
        )

        rank = self._normalize_place_rank(place_type)

        status = self._normalize_status(
            self._first_value(
                raw,
                "status",
                "record_status",
                "recordStatus",
                "gazetteer_status",
                "gazetteerStatus",
            )
        )

        parent_provider_id = normalize_space(
            self._first_value(
                raw,
                "parent_mrgid",
                "parentMRGID",
                "parent_id",
                "parentId",
            )
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
            base = normalize_space(
                self.definition.get(
                    "source_url",
                    self.DEFAULT_SOURCE_URL,
                )
            ).rstrip("/")

            source_url = (
                f"{base}/gazetteer.php?p=details&id={provider_id}"
            )

        return Taxon(
            provider=self.name,
            provider_id=provider_id,
            scientific_name=name,
            canonical_name=canonical_name,
            rank=rank,
            status=status,
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
                "programme": "marine_regions",
                "reference_only": True,
                "entity_type": "marine_geographic_feature",
                "mrgid": provider_id,
                "parent": {
                    "mrgid": parent_provider_id,
                    "name": normalize_space(
                        self._first_value(
                            raw,
                            "parent_name",
                            "parentName",
                            "parent_preferred_name",
                            "parentPreferredName",
                        )
                    ),
                    "place_type": normalize_space(
                        self._first_value(
                            raw,
                            "parent_place_type",
                            "parentPlaceType",
                        )
                    ),
                },
                "names": {
                    "preferred": name,
                    "gazetteer_name": normalize_space(
                        self._first_value(
                            raw,
                            "gazetteer_name",
                            "gazetteerName",
                        )
                    ),
                    "source_name": normalize_space(
                        self._first_value(
                            raw,
                            "source_name",
                            "sourceName",
                        )
                    ),
                    "alternate_names": self._normalize_alternate_names(
                        self._first_value(
                            raw,
                            "alternate_names",
                            "alternateNames",
                            "synonyms",
                            "other_names",
                            "otherNames",
                        )
                    ),
                },
                "feature": {
                    "place_type": place_type,
                    "place_type_id": normalize_space(
                        self._first_value(
                            raw,
                            "place_type_id",
                            "placeTypeId",
                        )
                    ),
                    "feature_code": normalize_space(
                        self._first_value(
                            raw,
                            "feature_code",
                            "featureCode",
                        )
                    ),
                    "feature_class": normalize_space(
                        self._first_value(
                            raw,
                            "feature_class",
                            "featureClass",
                        )
                    ),
                    "language": normalize_space(
                        self._first_value(
                            raw,
                            "language",
                            "lang",
                        )
                    ),
                    "historic": self._optional_bool(
                        self._first_value(
                            raw,
                            "historic",
                            "is_historic",
                            "isHistoric",
                        )
                    ),
                    "deprecated": self._optional_bool(
                        self._first_value(
                            raw,
                            "deprecated",
                            "is_deprecated",
                            "isDeprecated",
                        )
                    ),
                },
                "coordinates": {
                    "latitude": self._optional_float(
                        self._first_value(
                            raw,
                            "latitude",
                            "lat",
                            "central_latitude",
                            "centralLatitude",
                        )
                    ),
                    "longitude": self._optional_float(
                        self._first_value(
                            raw,
                            "longitude",
                            "lon",
                            "lng",
                            "central_longitude",
                            "centralLongitude",
                        )
                    ),
                    "minimum_depth_m": self._optional_float(
                        self._first_value(
                            raw,
                            "minimum_depth_m",
                            "minimumDepthM",
                            "minimum_depth",
                            "minimumDepth",
                        )
                    ),
                    "maximum_depth_m": self._optional_float(
                        self._first_value(
                            raw,
                            "maximum_depth_m",
                            "maximumDepthM",
                            "maximum_depth",
                            "maximumDepth",
                        )
                    ),
                    "average_depth_m": self._optional_float(
                        self._first_value(
                            raw,
                            "average_depth_m",
                            "averageDepthM",
                            "mean_depth",
                            "meanDepth",
                        )
                    ),
                    "elevation_m": self._optional_float(
                        self._first_value(
                            raw,
                            "elevation_m",
                            "elevationM",
                            "elevation",
                        )
                    ),
                },
                "geometry": {
                    "geometry": self._first_value(
                        raw,
                        "geometry",
                        "geojson",
                        "boundary",
                    ),
                    "geometry_type": normalize_space(
                        self._first_value(
                            raw,
                            "geometry_type",
                            "geometryType",
                        )
                    ),
                    "bbox": self._normalize_bbox(
                        self._first_value(
                            raw,
                            "bbox",
                            "bounding_box",
                            "boundingBox",
                        ),
                        raw=raw,
                    ),
                    "coordinate_reference_system": normalize_space(
                        self._first_value(
                            raw,
                            "coordinate_reference_system",
                            "coordinateReferenceSystem",
                            "crs",
                        )
                    ),
                    "area_km2": self._optional_float(
                        self._first_value(
                            raw,
                            "area_km2",
                            "areaKm2",
                            "area",
                        )
                    ),
                    "perimeter_km": self._optional_float(
                        self._first_value(
                            raw,
                            "perimeter_km",
                            "perimeterKm",
                        )
                    ),
                    "geometry_source": normalize_space(
                        self._first_value(
                            raw,
                            "geometry_source",
                            "geometrySource",
                        )
                    ),
                },
                "hierarchy": self._normalize_hierarchy(
                    self._first_value(
                        raw,
                        "hierarchy",
                        "ancestors",
                        "parent_chain",
                        "parentChain",
                    )
                ),
                "marine_context": {
                    "ocean": normalize_space(
                        self._first_value(
                            raw,
                            "ocean",
                            "ocean_name",
                            "oceanName",
                        )
                    ),
                    "sea": normalize_space(
                        self._first_value(
                            raw,
                            "sea",
                            "sea_name",
                            "seaName",
                        )
                    ),
                    "gulf": normalize_space(
                        self._first_value(
                            raw,
                            "gulf",
                            "gulf_name",
                            "gulfName",
                        )
                    ),
                    "bay": normalize_space(
                        self._first_value(
                            raw,
                            "bay",
                            "bay_name",
                            "bayName",
                        )
                    ),
                    "strait": normalize_space(
                        self._first_value(
                            raw,
                            "strait",
                            "strait_name",
                            "straitName",
                        )
                    ),
                    "basin": normalize_space(
                        self._first_value(
                            raw,
                            "basin",
                            "basin_name",
                            "basinName",
                        )
                    ),
                    "subbasin": normalize_space(
                        self._first_value(
                            raw,
                            "subbasin",
                            "subbasin_name",
                            "subbasinName",
                        )
                    ),
                    "marine": self._optional_bool(
                        self._first_value(
                            raw,
                            "marine",
                            "is_marine",
                            "isMarine",
                        )
                    ),
                    "coastal": self._optional_bool(
                        self._first_value(
                            raw,
                            "coastal",
                            "is_coastal",
                            "isCoastal",
                        )
                    ),
                    "freshwater": self._optional_bool(
                        self._first_value(
                            raw,
                            "freshwater",
                            "is_freshwater",
                            "isFreshwater",
                        )
                    ),
                    "brackish": self._optional_bool(
                        self._first_value(
                            raw,
                            "brackish",
                            "is_brackish",
                            "isBrackish",
                        )
                    ),
                },
                "maritime_jurisdiction": {
                    "eez": self._optional_bool(
                        self._first_value(
                            raw,
                            "eez",
                            "is_eez",
                            "isEez",
                        )
                    ),
                    "eez_mrgid": normalize_space(
                        self._first_value(
                            raw,
                            "eez_mrgid",
                            "eezMrgid",
                            "eezMRGID",
                        )
                    ),
                    "territorial_sea": self._optional_bool(
                        self._first_value(
                            raw,
                            "territorial_sea",
                            "territorialSea",
                        )
                    ),
                    "contiguous_zone": self._optional_bool(
                        self._first_value(
                            raw,
                            "contiguous_zone",
                            "contiguousZone",
                        )
                    ),
                    "continental_shelf": self._optional_bool(
                        self._first_value(
                            raw,
                            "continental_shelf",
                            "continentalShelf",
                        )
                    ),
                    "high_seas": self._optional_bool(
                        self._first_value(
                            raw,
                            "high_seas",
                            "highSeas",
                        )
                    ),
                    "sovereign": normalize_space(
                        self._first_value(
                            raw,
                            "sovereign",
                            "sovereign_name",
                            "sovereignName",
                        )
                    ),
                    "territory": normalize_space(
                        self._first_value(
                            raw,
                            "territory",
                            "territory_name",
                            "territoryName",
                        )
                    ),
                    "country_code": normalize_space(
                        self._first_value(
                            raw,
                            "country_code",
                            "countryCode",
                            "iso2",
                        )
                    ).upper(),
                    "iso3": normalize_space(
                        self._first_value(
                            raw,
                            "iso3",
                            "iso_alpha3",
                            "isoAlpha3",
                        )
                    ).upper(),
                },
                "ecoregions": {
                    "meow": self._normalize_regions(
                        self._first_value(
                            raw,
                            "marine_ecoregions",
                            "marineEcoregions",
                            "meow",
                        )
                    ),
                    "large_marine_ecosystems": self._normalize_regions(
                        self._first_value(
                            raw,
                            "large_marine_ecosystems",
                            "largeMarineEcosystems",
                            "lme",
                        )
                    ),
                    "longhurst_provinces": self._normalize_regions(
                        self._first_value(
                            raw,
                            "longhurst_provinces",
                            "longhurstProvinces",
                        )
                    ),
                    "ices_areas": self._normalize_regions(
                        self._first_value(
                            raw,
                            "ices_areas",
                            "icesAreas",
                        )
                    ),
                    "fao_fishing_areas": self._normalize_regions(
                        self._first_value(
                            raw,
                            "fao_fishing_areas",
                            "faoFishingAreas",
                        )
                    ),
                },
                "relations": self._normalize_relations(
                    self._first_value(
                        raw,
                        "relations",
                        "relationships",
                        "related_places",
                        "relatedPlaces",
                    )
                ),
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
                        "sources",
                    )
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
        """Normalize alternate Marine Regions place names."""

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
                        "language_code",
                        "languageCode",
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
                historic = cls._optional_bool(
                    cls._first_value(
                        item,
                        "historic",
                        "is_historic",
                        "isHistoric",
                    )
                )
                source = normalize_space(
                    cls._first_value(
                        item,
                        "source",
                        "authority",
                    )
                )
                raw_item = dict(item)
            else:
                name = normalize_space(item)
                language = ""
                preferred = None
                historic = None
                source = ""
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
                    "historic": historic,
                    "source": source,
                    "raw": raw_item,
                }
            )

        return result

    @classmethod
    def _normalize_hierarchy(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize Marine Regions parent hierarchy."""

        result: list[dict[str, Any]] = []

        for index, item in enumerate(cls._list_value(value)):
            if isinstance(item, Mapping):
                mrgid = normalize_space(
                    cls._first_value(
                        item,
                        "mrgid",
                        "MRGID",
                        "id",
                    )
                )
                name = normalize_space(
                    cls._first_value(
                        item,
                        "name",
                        "preferred_name",
                        "preferredName",
                    )
                )
                place_type = normalize_space(
                    cls._first_value(
                        item,
                        "place_type",
                        "placeType",
                        "type",
                    )
                )
                level = cls._optional_int(
                    cls._first_value(
                        item,
                        "level",
                        "position",
                        "order",
                    )
                )
                raw_item = dict(item)
            else:
                mrgid = ""
                name = normalize_space(item)
                place_type = ""
                level = index
                raw_item = item

            if level is None:
                level = index

            if mrgid or name:
                result.append(
                    {
                        "mrgid": mrgid,
                        "name": name,
                        "place_type": place_type,
                        "level": level,
                        "raw": raw_item,
                    }
                )

        return result

    @classmethod
    def _normalize_regions(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize ecoregion, LME, ICES, and FAO area records."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                entry = {
                    "mrgid": normalize_space(
                        cls._first_value(
                            item,
                            "mrgid",
                            "MRGID",
                            "id",
                        )
                    ),
                    "name": normalize_space(
                        cls._first_value(
                            item,
                            "name",
                            "region",
                            "area",
                        )
                    ),
                    "code": normalize_space(
                        cls._first_value(
                            item,
                            "code",
                            "region_code",
                            "regionCode",
                            "area_code",
                            "areaCode",
                        )
                    ),
                    "type": normalize_space(
                        cls._first_value(
                            item,
                            "type",
                            "place_type",
                            "placeType",
                        )
                    ),
                    "raw": dict(item),
                }
            else:
                entry = {
                    "mrgid": "",
                    "name": normalize_space(item),
                    "code": "",
                    "type": "",
                    "raw": item,
                }

            if entry["mrgid"] or entry["name"] or entry["code"]:
                result.append(entry)

        return result

    @classmethod
    def _normalize_relations(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        """Normalize Marine Regions place relationships."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                result.append(
                    {
                        "relation_type": normalize_space(
                            cls._first_value(
                                item,
                                "relation_type",
                                "relationType",
                                "relationship",
                                "type",
                            )
                        ),
                        "source_mrgid": normalize_space(
                            cls._first_value(
                                item,
                                "source_mrgid",
                                "sourceMrgid",
                                "from_mrgid",
                                "fromMrgid",
                            )
                        ),
                        "target_mrgid": normalize_space(
                            cls._first_value(
                                item,
                                "target_mrgid",
                                "targetMrgid",
                                "to_mrgid",
                                "toMrgid",
                                "mrgid",
                                "MRGID",
                            )
                        ),
                        "target_name": normalize_space(
                            cls._first_value(
                                item,
                                "target_name",
                                "targetName",
                                "name",
                            )
                        ),
                        "notes": normalize_space(
                            cls._first_value(
                                item,
                                "notes",
                                "remarks",
                            )
                        ),
                        "raw": dict(item),
                    }
                )
            else:
                relation = normalize_space(item)

                if relation:
                    result.append(
                        {
                            "relation_type": relation,
                            "source_mrgid": "",
                            "target_mrgid": "",
                            "target_name": "",
                            "notes": "",
                            "raw": item,
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
        """Normalize Marine Regions and external identifiers."""

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
            "mrgid": "Marine Regions",
            "MRGID": "Marine Regions",
            "geoname_id": "GeoNames",
            "geonameId": "GeoNames",
            "wikidata_id": "Wikidata",
            "wikidataId": "Wikidata",
            "osm_id": "OpenStreetMap",
            "osmId": "OpenStreetMap",
            "wdpa_id": "Protected Planet WDPA",
            "wdpaId": "Protected Planet WDPA",
            "eez_id": "Marine Regions EEZ",
            "eezId": "Marine Regions EEZ",
            "lme_id": "Large Marine Ecosystem",
            "lmeId": "Large Marine Ecosystem",
            "ices_code": "ICES",
            "icesCode": "ICES",
            "fao_area_code": "FAO Fishing Area",
            "faoAreaCode": "FAO Fishing Area",
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
        """Normalize gazetteer and boundary references."""

        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                result.append(
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
                        "source_id": normalize_space(
                            cls._first_value(
                                item,
                                "source_id",
                                "sourceId",
                                "id",
                            )
                        ),
                        "raw": dict(item),
                    }
                )
            else:
                citation = normalize_space(item)

                if citation:
                    result.append(
                        {
                            "citation": citation,
                            "authors": "",
                            "year": "",
                            "doi": "",
                            "url": (
                                citation
                                if citation.startswith(
                                    ("http://", "https://")
                                )
                                else ""
                            ),
                            "source_id": "",
                            "raw": item,
                        }
                    )

        return result

    @classmethod
    def _normalize_links(
        cls,
        value: Any,
    ) -> list[dict[str, str]]:
        """Normalize external marine geographic links."""

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

    @classmethod
    def _normalize_bbox(
        cls,
        value: Any,
        *,
        raw: Mapping[str, Any],
    ) -> dict[str, float | None]:
        """Normalize a marine geographic bounding box."""

        if isinstance(value, Mapping):
            north = cls._optional_float(
                cls._first_value(
                    value,
                    "north",
                    "max_lat",
                    "maxLat",
                )
            )
            south = cls._optional_float(
                cls._first_value(
                    value,
                    "south",
                    "min_lat",
                    "minLat",
                )
            )
            east = cls._optional_float(
                cls._first_value(
                    value,
                    "east",
                    "max_lon",
                    "maxLon",
                )
            )
            west = cls._optional_float(
                cls._first_value(
                    value,
                    "west",
                    "min_lon",
                    "minLon",
                )
            )
        else:
            north = cls._optional_float(
                cls._first_value(
                    raw,
                    "north",
                    "bbox_north",
                    "bboxNorth",
                )
            )
            south = cls._optional_float(
                cls._first_value(
                    raw,
                    "south",
                    "bbox_south",
                    "bboxSouth",
                )
            )
            east = cls._optional_float(
                cls._first_value(
                    raw,
                    "east",
                    "bbox_east",
                    "bboxEast",
                )
            )
            west = cls._optional_float(
                cls._first_value(
                    raw,
                    "west",
                    "bbox_west",
                    "bboxWest",
                )
            )

        return {
            "north": north,
            "south": south,
            "east": east,
            "west": west,
        }

    @staticmethod
    def _normalize_place_rank(value: Any) -> str:
        """Map Marine Regions place types into geographic entity ranks."""

        place_type = normalize_space(value).casefold()

        mappings = {
            "ocean": "ocean",
            "sea": "sea",
            "gulf": "gulf",
            "bay": "bay",
            "strait": "strait",
            "channel": "channel",
            "estuary": "estuary",
            "lagoon": "lagoon",
            "basin": "marine_basin",
            "subbasin": "marine_subbasin",
            "trench": "trench",
            "ridge": "ridge",
            "seamount": "seamount",
            "bank": "marine_bank",
            "shelf": "continental_shelf",
            "continental shelf": "continental_shelf",
            "slope": "continental_slope",
            "abyssal plain": "abyssal_plain",
            "island": "island",
            "island group": "island_group",
            "archipelago": "archipelago",
            "exclusive economic zone": "exclusive_economic_zone",
            "eez": "exclusive_economic_zone",
            "territorial sea": "territorial_sea",
            "high seas": "high_seas",
            "marine ecoregion": "marine_ecoregion",
            "large marine ecosystem": "large_marine_ecosystem",
            "fao fishing area": "fao_fishing_area",
            "ices area": "ices_area",
            "protected area": "marine_protected_area",
            "marine protected area": "marine_protected_area",
            "port": "port",
            "harbour": "harbour",
            "harbor": "harbour",
            "river": "river",
            "lake": "lake",
        }

        return mappings.get(
            place_type,
            place_type.replace(" ", "_")
            if place_type
            else "marine_geographic_feature",
        )

    @staticmethod
    def _normalize_status(value: Any) -> str:
        """Normalize Marine Regions record statuses."""

        status = normalize_space(value).casefold()

        aliases = {
            "accepted": "accepted",
            "valid": "accepted",
            "current": "accepted",
            "active": "accepted",
            "preferred": "accepted",
            "deprecated": "inactive",
            "obsolete": "inactive",
            "historic": "reference",
            "historical": "reference",
            "superseded": "inactive",
            "inactive": "inactive",
            "reference": "reference",
            "doubtful": "unknown",
            "unresolved": "unknown",
        }

        return aliases.get(
            status,
            status or "reference",
        )

    @staticmethod
    def _decode_cursor(cursor: str | None) -> int:
        """Decode a non-negative JSONL record offset."""

        if not cursor:
            return 0

        try:
            offset = int(cursor)
        except (TypeError, ValueError) as error:
            raise ProviderError(
                f"Invalid Marine Regions cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "Marine Regions cursor must be non-negative."
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

        if isinstance(value, str) and "|" in value:
            return [
                part.strip()
                for part in value.split("|")
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
            "present",
            "active",
        }:
            return True

        if normalized in {
            "0",
            "false",
            "no",
            "n",
            "absent",
            "inactive",
        }:
            return False

        return None
