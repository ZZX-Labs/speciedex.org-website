#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/wdpa.py

World Database on Protected Areas (WDPA) provider plug-in.

This provider consumes a normalized or semi-normalized JSONL export configured
through providers.json. It is intended for protected-area names, WDPA and PID
identifiers, designation and designation type, legal status, IUCN management
category, governance, ownership, management authority, marine and terrestrial
extent, countries, subnational jurisdictions, coordinates, geometry, area,
references, external identifiers, and provenance metadata.

WDPA is a protected-area and conservation geography authority rather than a
taxonomic authority. Records are represented through the shared Speciedex Taxon
contract as reference-oriented protected-area entities. The complete source
object is preserved under ``Taxon.extra["raw"]``.

Required provider configuration:

    {
        "name": "wdpa",
        "path": "static/data/providers/wdpa/protected-areas.jsonl"
    }

Optional configuration:

    {
        "page_size": 1000,
        "source_name": "World Database on Protected Areas",
        "source_url": "https://www.protectedplanet.net/"
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
    """File-backed WDPA provider."""

    PROVIDER_NAME = "wdpa"

    DEFAULT_SOURCE_NAME = "World Database on Protected Areas"
    DEFAULT_SOURCE_URL = "https://www.protectedplanet.net/"

    def fetch(self) -> Batch:
        """Read and normalize one resumable WDPA JSONL batch."""

        source_path = self._source_path()

        if not source_path.exists():
            raise ProviderError(
                f"WDPA export not found: {source_path}"
            )

        if not source_path.is_file():
            raise ProviderError(
                f"WDPA path is not a file: {source_path}"
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
                            f"Invalid WDPA JSON at "
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
        """Resolve the configured WDPA JSONL source path."""

        configured = normalize_space(
            self.definition.get("path")
            or self.definition.get("file")
            or self.definition.get("source_path")
        )

        if not configured:
            raise ProviderError(
                "WDPA provider requires a path."
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
        """Normalize one protected-area record."""

        wdpa_id = normalize_space(
            self._first_value(
                raw,
                "wdpa_id",
                "WDPAID",
                "wdpaId",
                "wdpaid",
            )
        )

        pid = normalize_space(
            self._first_value(
                raw,
                "pid",
                "PID",
                "protected_area_id",
                "protectedAreaId",
            )
        )

        provider_id = wdpa_id or pid or normalize_space(
            self._first_value(
                raw,
                "id",
                "record_id",
                "recordId",
            )
        )

        name = normalize_space(
            self._first_value(
                raw,
                "name",
                "NAME",
                "protected_area_name",
                "protectedAreaName",
                "site_name",
                "siteName",
            )
        )

        if not provider_id or not name:
            return None

        original_name = normalize_space(
            self._first_value(
                raw,
                "original_name",
                "ORIG_NAME",
                "originalName",
            )
        )

        canonical_name = original_name or name

        designation = normalize_space(
            self._first_value(
                raw,
                "designation",
                "DESIG",
                "desig",
            )
        )

        designation_type = normalize_space(
            self._first_value(
                raw,
                "designation_type",
                "DESIG_TYPE",
                "designationType",
            )
        )

        status = self._normalize_status(
            self._first_value(
                raw,
                "status",
                "STATUS",
                "legal_status",
                "legalStatus",
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
            source_url = f"{base}/protected-areas/{provider_id}"

        return Taxon(
            provider=self.name,
            provider_id=provider_id,
            scientific_name=name,
            canonical_name=canonical_name,
            rank=self._normalize_rank(
                designation_type or designation
            ),
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
                "programme": "wdpa",
                "reference_only": True,
                "entity_type": "protected_area",
                "wdpa_id": wdpa_id,
                "pid": pid,
                "names": {
                    "name": name,
                    "original_name": original_name,
                    "english_name": normalize_space(
                        self._first_value(
                            raw,
                            "english_name",
                            "englishName",
                        )
                    ),
                    "alternative_names": self._normalize_names(
                        self._first_value(
                            raw,
                            "alternative_names",
                            "alternativeNames",
                            "aliases",
                            "synonyms",
                        )
                    ),
                },
                "designation": {
                    "name": designation,
                    "type": designation_type,
                    "iucn_category": normalize_space(
                        self._first_value(
                            raw,
                            "iucn_category",
                            "IUCN_CAT",
                            "iucnCategory",
                        )
                    ),
                    "international_criteria": self._list_value(
                        self._first_value(
                            raw,
                            "international_criteria",
                            "internationalCriteria",
                            "criteria",
                        )
                    ),
                    "designation_date": normalize_space(
                        self._first_value(
                            raw,
                            "designation_date",
                            "STATUS_YR",
                            "designationDate",
                            "status_year",
                            "statusYear",
                        )
                    ),
                    "legal_status": normalize_space(
                        self._first_value(
                            raw,
                            "legal_status",
                            "STATUS",
                            "legalStatus",
                        )
                    ),
                    "legal_instrument": normalize_space(
                        self._first_value(
                            raw,
                            "legal_instrument",
                            "legalInstrument",
                        )
                    ),
                    "legal_reference": normalize_space(
                        self._first_value(
                            raw,
                            "legal_reference",
                            "legalReference",
                        )
                    ),
                },
                "governance": {
                    "governance_type": normalize_space(
                        self._first_value(
                            raw,
                            "governance_type",
                            "GOV_TYPE",
                            "governanceType",
                        )
                    ),
                    "ownership_type": normalize_space(
                        self._first_value(
                            raw,
                            "ownership_type",
                            "OWN_TYPE",
                            "ownershipType",
                        )
                    ),
                    "management_authority": normalize_space(
                        self._first_value(
                            raw,
                            "management_authority",
                            "MANG_AUTH",
                            "managementAuthority",
                        )
                    ),
                    "management_plan": normalize_space(
                        self._first_value(
                            raw,
                            "management_plan",
                            "managementPlan",
                        )
                    ),
                    "management_plan_url": normalize_space(
                        self._first_value(
                            raw,
                            "management_plan_url",
                            "managementPlanUrl",
                        )
                    ),
                },
                "marine_context": {
                    "marine": self._optional_bool(
                        self._first_value(
                            raw,
                            "marine",
                            "MARINE",
                            "is_marine",
                            "isMarine",
                        )
                    ),
                    "marine_area_km2": self._optional_float(
                        self._first_value(
                            raw,
                            "marine_area_km2",
                            "REP_M_AREA",
                            "marineAreaKm2",
                        )
                    ),
                    "terrestrial_area_km2": self._optional_float(
                        self._first_value(
                            raw,
                            "terrestrial_area_km2",
                            "REP_AREA",
                            "terrestrialAreaKm2",
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
                },
                "area": {
                    "reported_area_km2": self._optional_float(
                        self._first_value(
                            raw,
                            "reported_area_km2",
                            "REP_AREA",
                            "reportedAreaKm2",
                        )
                    ),
                    "gis_area_km2": self._optional_float(
                        self._first_value(
                            raw,
                            "gis_area_km2",
                            "GIS_AREA",
                            "gisAreaKm2",
                        )
                    ),
                    "reported_marine_area_km2": self._optional_float(
                        self._first_value(
                            raw,
                            "reported_marine_area_km2",
                            "REP_M_AREA",
                            "reportedMarineAreaKm2",
                        )
                    ),
                    "gis_marine_area_km2": self._optional_float(
                        self._first_value(
                            raw,
                            "gis_marine_area_km2",
                            "GIS_M_AREA",
                            "gisMarineAreaKm2",
                        )
                    ),
                    "perimeter_km": self._optional_float(
                        self._first_value(
                            raw,
                            "perimeter_km",
                            "perimeterKm",
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
                    "point": self._normalize_point(raw),
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
                },
                "jurisdiction": {
                    "countries": self._normalize_regions(
                        self._first_value(
                            raw,
                            "countries",
                            "country_records",
                            "countryRecords",
                            "ISO3",
                        )
                    ),
                    "subnational_units": self._normalize_regions(
                        self._first_value(
                            raw,
                            "subnational_units",
                            "subnationalUnits",
                            "SUB_LOC",
                        )
                    ),
                    "sovereign_state": normalize_space(
                        self._first_value(
                            raw,
                            "sovereign_state",
                            "sovereignState",
                        )
                    ),
                    "transboundary": self._optional_bool(
                        self._first_value(
                            raw,
                            "transboundary",
                            "is_transboundary",
                            "isTransboundary",
                        )
                    ),
                    "transboundary_group": normalize_space(
                        self._first_value(
                            raw,
                            "transboundary_group",
                            "transboundaryGroup",
                        )
                    ),
                },
                "ecology": {
                    "biomes": self._list_value(
                        self._first_value(
                            raw,
                            "biomes",
                            "biome",
                        )
                    ),
                    "ecoregions": self._normalize_regions(
                        self._first_value(
                            raw,
                            "ecoregions",
                            "ecoregion_records",
                            "ecoregionRecords",
                        )
                    ),
                    "habitats": self._list_value(
                        self._first_value(
                            raw,
                            "habitats",
                            "habitat",
                        )
                    ),
                    "key_biodiversity_area": self._optional_bool(
                        self._first_value(
                            raw,
                            "key_biodiversity_area",
                            "keyBiodiversityArea",
                            "is_kba",
                            "isKba",
                        )
                    ),
                    "world_heritage_site": self._optional_bool(
                        self._first_value(
                            raw,
                            "world_heritage_site",
                            "worldHeritageSite",
                        )
                    ),
                    "ramsar_site": self._optional_bool(
                        self._first_value(
                            raw,
                            "ramsar_site",
                            "ramsarSite",
                        )
                    ),
                    "biosphere_reserve": self._optional_bool(
                        self._first_value(
                            raw,
                            "biosphere_reserve",
                            "biosphereReserve",
                        )
                    ),
                },
                "species": self._normalize_species(
                    self._first_value(
                        raw,
                        "species",
                        "associated_species",
                        "associatedSpecies",
                        "trigger_species",
                        "triggerSpecies",
                    )
                ),
                "threats": self._normalize_named_records(
                    self._first_value(
                        raw,
                        "threats",
                        "threat_records",
                        "threatRecords",
                    )
                ),
                "conservation_actions": self._normalize_named_records(
                    self._first_value(
                        raw,
                        "conservation_actions",
                        "conservationActions",
                        "actions",
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
                    wdpa_id=wdpa_id,
                    pid=pid,
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
                        "related_links",
                        "relatedLinks",
                    )
                ),
                "provenance": {
                    "source_name": normalize_space(
                        self._first_value(
                            raw,
                            "source_name",
                            "sourceName",
                        )
                    ),
                    "source_type": normalize_space(
                        self._first_value(
                            raw,
                            "source_type",
                            "sourceType",
                        )
                    ),
                    "metadata_id": normalize_space(
                        self._first_value(
                            raw,
                            "metadata_id",
                            "METADATAID",
                            "metadataId",
                        )
                    ),
                    "verification_status": normalize_space(
                        self._first_value(
                            raw,
                            "verification_status",
                            "VERIF",
                            "verificationStatus",
                        )
                    ),
                    "version": normalize_space(
                        self._first_value(
                            raw,
                            "version",
                            "dataset_version",
                            "datasetVersion",
                        )
                    ),
                    "release_date": normalize_space(
                        self._first_value(
                            raw,
                            "release_date",
                            "releaseDate",
                        )
                    ),
                    "license": normalize_space(
                        self._first_value(
                            raw,
                            "license",
                            "rights",
                        )
                    ),
                },
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
    def _normalize_names(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                name = normalize_space(
                    cls._first_value(
                        item,
                        "name",
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
                raw_item = dict(item)
            else:
                name = normalize_space(item)
                language = ""
                raw_item = item

            key = (name.casefold(), language.casefold())

            if not name or key in seen:
                continue

            seen.add(key)
            result.append(
                {
                    "name": name,
                    "language": language,
                    "raw": raw_item,
                }
            )

        return result

    @classmethod
    def _normalize_regions(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                entry = {
                    "name": normalize_space(
                        cls._first_value(
                            item,
                            "name",
                            "country",
                            "region",
                            "area",
                        )
                    ),
                    "code": normalize_space(
                        cls._first_value(
                            item,
                            "code",
                            "country_code",
                            "countryCode",
                            "iso3",
                            "ISO3",
                        )
                    ).upper(),
                    "type": normalize_space(
                        cls._first_value(
                            item,
                            "type",
                            "region_type",
                            "regionType",
                        )
                    ),
                    "raw": dict(item),
                }
            else:
                text = normalize_space(item)
                entry = {
                    "name": text if len(text) > 3 else "",
                    "code": text.upper() if len(text) <= 3 else "",
                    "type": "",
                    "raw": item,
                }

            if entry["name"] or entry["code"]:
                result.append(entry)

        return result

    @classmethod
    def _normalize_species(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                result.append(
                    {
                        "scientific_name": normalize_space(
                            cls._first_value(
                                item,
                                "scientific_name",
                                "scientificName",
                                "name",
                            )
                        ),
                        "taxon_id": normalize_space(
                            cls._first_value(
                                item,
                                "taxon_id",
                                "taxonId",
                                "id",
                            )
                        ),
                        "source": normalize_space(
                            cls._first_value(
                                item,
                                "source",
                                "database",
                            )
                        ),
                        "status": normalize_space(
                            cls._first_value(
                                item,
                                "status",
                                "presence",
                            )
                        ),
                        "trigger": cls._optional_bool(
                            cls._first_value(
                                item,
                                "trigger",
                                "is_trigger",
                                "isTrigger",
                            )
                        ),
                        "raw": dict(item),
                    }
                )
            else:
                name = normalize_space(item)

                if name:
                    result.append(
                        {
                            "scientific_name": name,
                            "taxon_id": "",
                            "source": "",
                            "status": "",
                            "trigger": None,
                            "raw": item,
                        }
                    )

        return result

    @classmethod
    def _normalize_named_records(
        cls,
        value: Any,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for item in cls._list_value(value):
            if isinstance(item, Mapping):
                result.append(
                    {
                        "name": normalize_space(
                            cls._first_value(
                                item,
                                "name",
                                "title",
                                "description",
                            )
                        ),
                        "code": normalize_space(
                            cls._first_value(
                                item,
                                "code",
                                "id",
                            )
                        ),
                        "status": normalize_space(
                            cls._first_value(
                                item,
                                "status",
                                "state",
                            )
                        ),
                        "reference": normalize_space(
                            cls._first_value(
                                item,
                                "reference",
                                "citation",
                            )
                        ),
                        "raw": dict(item),
                    }
                )
            else:
                text = normalize_space(item)

                if text:
                    result.append(
                        {
                            "name": text,
                            "code": "",
                            "status": "",
                            "reference": "",
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
        wdpa_id: str,
        pid: str,
    ) -> list[dict[str, str]]:
        result: list[dict[str, str]] = []
        seen: set[tuple[str, str]] = set()

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

            key = (source.casefold(), identifier.casefold())

            if identifier and key not in seen:
                seen.add(key)
                result.append(
                    {
                        "identifier": identifier,
                        "source": source,
                    }
                )

        known = {
            "WDPA": wdpa_id,
            "Protected Planet PID": pid,
            "Ramsar": normalize_space(
                cls._first_value(
                    raw,
                    "ramsar_id",
                    "ramsarId",
                )
            ),
            "UNESCO World Heritage": normalize_space(
                cls._first_value(
                    raw,
                    "world_heritage_id",
                    "worldHeritageId",
                )
            ),
            "UNESCO MAB": normalize_space(
                cls._first_value(
                    raw,
                    "biosphere_reserve_id",
                    "biosphereReserveId",
                )
            ),
            "KBA": normalize_space(
                cls._first_value(
                    raw,
                    "kba_id",
                    "kbaId",
                )
            ),
            "GeoNames": normalize_space(
                cls._first_value(
                    raw,
                    "geoname_id",
                    "geonameId",
                )
            ),
            "Wikidata": normalize_space(
                cls._first_value(
                    raw,
                    "wikidata_id",
                    "wikidataId",
                )
            ),
            "OpenStreetMap": normalize_space(
                cls._first_value(
                    raw,
                    "osm_id",
                    "osmId",
                )
            ),
            "Marine Regions": normalize_space(
                cls._first_value(
                    raw,
                    "mrgid",
                    "MRGID",
                )
            ),
        }

        for source, identifier in known.items():
            key = (source.casefold(), identifier.casefold())

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
                            item.get("doi")
                        ).removeprefix("https://doi.org/"),
                        "url": normalize_space(
                            cls._first_value(
                                item,
                                "url",
                                "source_url",
                                "sourceUrl",
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
                            "url": "",
                            "raw": item,
                        }
                    )

        return result

    @classmethod
    def _normalize_links(
        cls,
        value: Any,
    ) -> list[dict[str, str]]:
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
    def _normalize_point(
        cls,
        raw: Mapping[str, Any],
    ) -> dict[str, float | None]:
        return {
            "latitude": cls._optional_float(
                cls._first_value(
                    raw,
                    "latitude",
                    "lat",
                    "decimal_latitude",
                    "decimalLatitude",
                )
            ),
            "longitude": cls._optional_float(
                cls._first_value(
                    raw,
                    "longitude",
                    "lon",
                    "lng",
                    "decimal_longitude",
                    "decimalLongitude",
                )
            ),
        }

    @classmethod
    def _normalize_bbox(
        cls,
        value: Any,
        *,
        raw: Mapping[str, Any],
    ) -> dict[str, float | None]:
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
    def _normalize_rank(value: Any) -> str:
        text = normalize_space(value).casefold()

        mappings = {
            "national": "protected_area",
            "regional": "protected_area",
            "international": "protected_area",
            "national park": "national_park",
            "nature reserve": "nature_reserve",
            "marine protected area": "marine_protected_area",
            "ramsar site": "ramsar_site",
            "world heritage site": "world_heritage_site",
            "biosphere reserve": "biosphere_reserve",
            "strict nature reserve": "strict_nature_reserve",
            "wilderness area": "wilderness_area",
            "natural monument": "natural_monument",
            "habitat/species management area": (
                "habitat_species_management_area"
            ),
            "protected landscape/seascape": (
                "protected_landscape_seascape"
            ),
            "protected area with sustainable use": (
                "protected_area_sustainable_use"
            ),
        }

        return mappings.get(
            text,
            text.replace(" ", "_")
            if text
            else "protected_area",
        )

    @staticmethod
    def _normalize_status(value: Any) -> str:
        status = normalize_space(value).casefold()

        aliases = {
            "designated": "accepted",
            "established": "accepted",
            "inscribed": "accepted",
            "adopted": "accepted",
            "active": "accepted",
            "accepted": "accepted",
            "proposed": "provisionally accepted",
            "not reported": "reference",
            "unknown": "unknown",
            "degazetted": "inactive",
            "abolished": "inactive",
            "revoked": "inactive",
            "inactive": "inactive",
        }

        return aliases.get(
            status,
            status or "reference",
        )

    @staticmethod
    def _decode_cursor(cursor: str | None) -> int:
        if not cursor:
            return 0

        try:
            offset = int(cursor)
        except (TypeError, ValueError) as error:
            raise ProviderError(
                f"Invalid WDPA cursor: {cursor!r}."
            ) from error

        if offset < 0:
            raise ProviderError(
                "WDPA cursor must be non-negative."
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
            "marine",
            "designated",
        }:
            return True

        if normalized in {
            "0",
            "false",
            "no",
            "n",
            "absent",
            "inactive",
            "terrestrial",
        }:
            return False

        return None
