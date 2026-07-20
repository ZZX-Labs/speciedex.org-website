#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/darwin_core_archive.py

Standards-grade Darwin Core Archive ingestion provider.

Darwin Core is not a biological nomenclatural code. It is the principal
biodiversity-data vocabulary and exchange model used to publish taxon,
occurrence, specimen, event, location, identification, measurement, media,
vernacular-name, distribution, and related records.

Nomenclatural correctness remains governed by domain-specific codes and
authorities such as the ICZN, ICNafp, ICNP, ICTV, ZooBank, IPNI, MycoBank,
LPSN, and related registries. This adapter therefore preserves Darwin Core
data and provenance without treating every published name as automatically
accepted or nomenclaturally valid.

The provider ingests Darwin Core Archives from ZIP files or extracted archive
directories. It reads ``meta.xml`` when available, reads ``eml.xml`` metadata
when available, maps the archive core into the Speciedex Taxon contract,
optionally joins extension rows by core identifier, validates archive
structure, preserves full Darwin Core terms, and supports resumable batches.

Major capabilities:

- ZIP archives and extracted archive directories.
- Safe archive-member normalization and path-traversal rejection.
- ``meta.xml`` parsing for core and extension definitions.
- ``eml.xml`` parsing for dataset title, creators, contacts, abstract,
  intellectual rights, citation, geographic coverage, temporal coverage,
  taxonomic coverage, and publication date.
- Headered and index-based delimited tables.
- CSV, TSV, pipe-delimited, and custom single-character delimiters.
- UTF-8 BOM handling and configurable archive/table encodings.
- Taxon, Occurrence, Event, MaterialSample, PreservedSpecimen, FossilSpecimen,
  LivingSpecimen, HumanObservation, MachineObservation, and other row types.
- Stable identity selection for taxon-centric and occurrence-centric archives.
- Full Darwin Core URI and local-name aliases for every field.
- Taxonomic hierarchy, accepted-name, parent-name, original-name, and
  nomenclatural metadata.
- Occurrence, event, location, geological context, identification,
  measurement, material-sample, institution, collection, rights, and
  attribution metadata.
- Extension joins for VernacularName, Distribution, Description,
  MeasurementOrFact, Multimedia, ResourceRelationship, TypesAndSpecimen,
  SpeciesProfile, Reference, and arbitrary extension row types.
- Extension allowlists, denylists, row limits, and malformed-row accounting.
- Archive fingerprints embedded in cursors so resume state is invalidated
  safely when the source archive changes.
- Declarative mapping, defaults, computed fields, transforms, filters,
  references, media, identifiers, and extra-field rules inherited from
  GenericJSONLProvider.
- Complete raw core-row and extension-row preservation.
- Structured validation diagnostics in ``Taxon.extra["darwin_core"]``.

Example providers.json entry:

    {
      "name": "example_dwca",
      "adapter": "darwin_core_archive",
      "path": "static/data/providers/example/example-dwca.zip",
      "join_extensions": true,
      "extension_allowlist": [
        "VernacularName",
        "Distribution",
        "Description",
        "MeasurementOrFact",
        "Multimedia"
      ],
      "max_extension_rows_per_core": 500,
      "identity_mode": "auto",
      "strict": false,
      "preserve_raw": true
    }

Copyright (c) 2026 ZZX-Laboratories
Licensed under the MIT License.
"""

import csv
import io
import json
import os
import re
import stat
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Iterator, Mapping, Sequence, TextIO
from xml.etree import ElementTree

from .common import (
    Batch,
    ProviderError,
    Taxon,
    normalize_space,
    now,
    safe_int,
)
from .generic_jsonl import (
    GenericJSONLProvider,
    _MISSING,
    _coerce_list,
    _is_empty,
)


DWC_TEXT_NS = "http://rs.tdwg.org/dwc/text/"
DWC_TERMS = "http://rs.tdwg.org/dwc/terms/"
DCTERMS = "http://purl.org/dc/terms/"
GBIF_TERMS = "http://rs.gbif.org/terms/1.0/"
AC_TERMS = "http://rs.tdwg.org/ac/terms/"
IUCN_TERMS = "http://iucn.org/terms/"
EML_NS = "eml://ecoinformatics.org/eml-2.1.1"

_LOCAL_NAME = re.compile(r"[^/#]+$")
_WHITESPACE = re.compile(r"\s+")

TAXON_ROW_TYPES = {
    f"{DWC_TERMS}Taxon",
    "Taxon",
}

OCCURRENCE_LIKE_ROW_TYPES = {
    f"{DWC_TERMS}Occurrence",
    f"{DWC_TERMS}PreservedSpecimen",
    f"{DWC_TERMS}FossilSpecimen",
    f"{DWC_TERMS}LivingSpecimen",
    f"{DWC_TERMS}MaterialSample",
    f"{DWC_TERMS}HumanObservation",
    f"{DWC_TERMS}MachineObservation",
    "Occurrence",
    "PreservedSpecimen",
    "FossilSpecimen",
    "LivingSpecimen",
    "MaterialSample",
    "HumanObservation",
    "MachineObservation",
}

EVENT_ROW_TYPES = {
    f"{DWC_TERMS}Event",
    "Event",
}

KNOWN_EXTENSION_NAMES = {
    "VernacularName",
    "Distribution",
    "Description",
    "MeasurementOrFact",
    "Multimedia",
    "SimpleMultimedia",
    "ResourceRelationship",
    "TypesAndSpecimen",
    "SpeciesProfile",
    "Reference",
    "Identifier",
    "DNA",
    "Audubon",
}


def utc_now() -> str:
    """Return a stable UTC timestamp."""

    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def local_term_name(term: str) -> str:
    """Return the final fragment of a term URI or qualified name."""

    normalized = normalize_space(term)
    match = _LOCAL_NAME.search(normalized)
    return match.group(0) if match else normalized


def decode_xml_character(
    value: str | None,
    default: str,
) -> str:
    """Decode escaped delimiter, quote, and line-ending attributes."""

    if value is None or value == "":
        return default

    replacements = {
        r"\t": "\t",
        r"\n": "\n",
        r"\r": "\r",
        r"\"": '"',
        r"\'": "'",
        r"\\": "\\",
        "&#9;": "\t",
        "&#10;": "\n",
        "&#13;": "\r",
        "&#34;": '"',
        "&#39;": "'",
    }

    return replacements.get(value, value)


def normalize_member_name(member: str) -> str:
    """
    Normalize an archive member and reject absolute or traversal paths.

    Darwin Core Archives should contain relative POSIX-style member paths.
    """

    raw = normalize_space(member).replace("\\", "/")

    if not raw:
        raise ProviderError("Darwin Core archive member path is empty.")

    path = PurePosixPath(raw)

    if path.is_absolute() or ".." in path.parts:
        raise ProviderError(
            f"Unsafe Darwin Core archive member path: {member!r}"
        )

    normalized = path.as_posix().lstrip("./")

    if not normalized:
        raise ProviderError(
            f"Unsafe Darwin Core archive member path: {member!r}"
        )

    return normalized


def clean_xml_text(value: str | None) -> str:
    """Collapse XML text content into a single readable string."""

    return _WHITESPACE.sub(" ", value or "").strip()


@dataclass(frozen=True)
class ArchiveField:
    """One Darwin Core field definition."""

    index: int
    term: str
    default: str = ""


@dataclass(frozen=True)
class ArchiveTable:
    """Core or extension table definition from meta.xml."""

    role: str
    row_type: str
    files: tuple[str, ...]
    fields: tuple[ArchiveField, ...]
    id_index: int | None
    coreid_index: int | None
    ignore_header_lines: int
    fields_terminated_by: str
    lines_terminated_by: str
    fields_enclosed_by: str
    encoding: str

    @property
    def primary_file(self) -> str:
        if not self.files:
            raise ProviderError(
                f"Darwin Core {self.role} table has no files."
            )

        return self.files[0]

    @property
    def extension_name(self) -> str:
        return local_term_name(self.row_type) or self.role


@dataclass
class ArchiveDiagnostics:
    """Mutable counters accumulated while ingesting an archive."""

    malformed_core_rows: int = 0
    malformed_extension_rows: int = 0
    truncated_extension_rows: int = 0
    missing_core_ids: int = 0
    duplicate_core_ids: int = 0
    rejected_records: int = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "malformed_core_rows": self.malformed_core_rows,
            "malformed_extension_rows": self.malformed_extension_rows,
            "truncated_extension_rows": self.truncated_extension_rows,
            "missing_core_ids": self.missing_core_ids,
            "duplicate_core_ids": self.duplicate_core_ids,
            "rejected_records": self.rejected_records,
        }


class ArchiveSource:
    """Uniform safe reader for ZIP archives and extracted directories."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._zip: zipfile.ZipFile | None = None
        self._members: dict[str, str] = {}

        if path.is_file():
            if not zipfile.is_zipfile(path):
                raise ProviderError(
                    f"Darwin Core archive is not a valid ZIP: {path}"
                )

            self._zip = zipfile.ZipFile(path, "r")
            self._validate_zip_members()

            for name in self._zip.namelist():
                normalized = normalize_member_name(name)
                self._members[normalized] = name

        elif path.is_dir():
            root = path.resolve()

            for candidate in path.rglob("*"):
                if not candidate.is_file():
                    continue

                resolved = candidate.resolve()

                if root not in resolved.parents:
                    raise ProviderError(
                        f"Darwin Core directory escapes archive root: "
                        f"{candidate}"
                    )

                normalized = candidate.relative_to(path).as_posix()
                self._members[normalize_member_name(normalized)] = normalized
        else:
            raise ProviderError(
                f"Darwin Core archive path is invalid: {path}"
            )

    def _validate_zip_members(self) -> None:
        assert self._zip is not None

        for info in self._zip.infolist():
            normalize_member_name(info.filename)

            mode = (info.external_attr >> 16) & 0xFFFF

            if mode and stat.S_ISLNK(mode):
                raise ProviderError(
                    f"Darwin Core ZIP contains a symbolic link: "
                    f"{info.filename}"
                )

    def close(self) -> None:
        if self._zip is not None:
            self._zip.close()

    def __enter__(self) -> "ArchiveSource":
        return self

    def __exit__(
        self,
        exc_type: Any,
        exc: Any,
        traceback: Any,
    ) -> None:
        self.close()

    def exists(self, member: str) -> bool:
        try:
            normalized = normalize_member_name(member)
        except ProviderError:
            return False

        return normalized in self._members

    def resolve_member(self, member: str) -> str:
        normalized = normalize_member_name(member)
        actual = self._members.get(normalized)

        if actual is None:
            raise ProviderError(
                f"Darwin Core archive member not found: {member}"
            )

        return actual

    def read_bytes(self, member: str) -> bytes:
        actual = self.resolve_member(member)

        if self._zip is not None:
            return self._zip.read(actual)

        return (self.path / actual).read_bytes()

    def open_text(
        self,
        member: str,
        *,
        encoding: str,
        newline: str = "",
    ) -> TextIO:
        actual = self.resolve_member(member)
        normalized_encoding = encoding or "utf-8"

        if normalized_encoding.casefold() == "utf-8":
            normalized_encoding = "utf-8-sig"

        if self._zip is not None:
            binary = self._zip.open(actual, "r")
            return io.TextIOWrapper(
                binary,
                encoding=normalized_encoding,
                errors="replace",
                newline=newline,
            )

        return (self.path / actual).open(
            "r",
            encoding=normalized_encoding,
            errors="replace",
            newline=newline,
        )

    def members(self) -> list[str]:
        return sorted(self._members)


class Provider(GenericJSONLProvider):
    """Standards-grade Darwin Core Archive provider."""

    PROVIDER_NAME = "darwin_core_archive"

    DEFAULT_MAPPING = {
        "provider_id": [
            f"{DWC_TERMS}taxonID",
            f"{DWC_TERMS}scientificNameID",
            f"{DWC_TERMS}occurrenceID",
            f"{DWC_TERMS}materialSampleID",
            f"{DWC_TERMS}eventID",
            "taxonID",
            "scientificNameID",
            "occurrenceID",
            "materialSampleID",
            "eventID",
            "_core_id",
            "id",
        ],
        "scientific_name": [
            f"{DWC_TERMS}scientificName",
            f"{DWC_TERMS}acceptedNameUsage",
            f"{DWC_TERMS}verbatimIdentification",
            "scientificName",
            "acceptedNameUsage",
            "verbatimIdentification",
        ],
        "canonical_name": [
            f"{DWC_TERMS}genericName",
            f"{DWC_TERMS}scientificName",
            "canonicalName",
            "scientificName",
        ],
        "rank": [
            f"{DWC_TERMS}taxonRank",
            f"{DWC_TERMS}verbatimTaxonRank",
            "taxonRank",
            "verbatimTaxonRank",
        ],
        "status": [
            f"{DWC_TERMS}taxonomicStatus",
            f"{DWC_TERMS}nomenclaturalStatus",
            f"{DWC_TERMS}occurrenceStatus",
            "taxonomicStatus",
            "nomenclaturalStatus",
            "occurrenceStatus",
        ],
        "authorship": [
            f"{DWC_TERMS}scientificNameAuthorship",
            "scientificNameAuthorship",
        ],
        "kingdom": [f"{DWC_TERMS}kingdom", "kingdom"],
        "phylum": [f"{DWC_TERMS}phylum", "phylum"],
        "class_name": [f"{DWC_TERMS}class", "class"],
        "order": [f"{DWC_TERMS}order", "order"],
        "family": [f"{DWC_TERMS}family", "family"],
        "genus": [f"{DWC_TERMS}genus", "genus"],
        "accepted_provider_id": [
            f"{DWC_TERMS}acceptedNameUsageID",
            "acceptedNameUsageID",
        ],
        "source_url": [
            f"{DWC_TERMS}references",
            f"{DCTERMS}references",
            "references",
        ],
        "source_modified": [
            f"{DWC_TERMS}modified",
            f"{DCTERMS}modified",
            "modified",
        ],
    }

    def fetch(self) -> Batch:
        """Read and normalize one resumable Darwin Core core-table batch."""

        archive_path = self._source_path()
        fingerprint = self._archive_fingerprint(archive_path)
        cursor = self._decode_dwca_cursor(
            self.cursor,
            fingerprint=fingerprint,
        )
        page_size = self._page_size()
        retrieved_at = now()
        diagnostics = ArchiveDiagnostics()

        records: list[Taxon] = []
        raw_count = 0
        next_offset = cursor["offset"]
        exhausted = True

        with ArchiveSource(archive_path) as source:
            metadata = self._read_metadata(source)
            core: ArchiveTable = metadata["core"]
            extensions: list[ArchiveTable] = metadata["extensions"]
            eml = self._read_eml_metadata(source)

            self._validate_table_definition(
                source,
                core,
                strict=True,
            )

            for extension in extensions:
                self._validate_table_definition(
                    source,
                    extension,
                    strict=False,
                )

            core_rows: list[tuple[int, dict[str, Any]]] = []
            seen_core_ids: set[str] = set()

            for source_index, row, malformed in self._iter_table_rows(
                source,
                core,
                start_offset=cursor["offset"],
            ):
                if raw_count >= page_size:
                    exhausted = False
                    break

                next_offset = source_index + 1
                raw_count += 1

                if malformed:
                    diagnostics.malformed_core_rows += 1

                core_id = normalize_space(row.get("_core_id"))

                if not core_id:
                    diagnostics.missing_core_ids += 1
                elif core_id in seen_core_ids:
                    diagnostics.duplicate_core_ids += 1
                else:
                    seen_core_ids.add(core_id)

                core_rows.append((source_index, row))

            extension_rows: dict[str, dict[str, list[dict[str, Any]]]] = {}

            if core_rows and bool(
                self.definition.get("join_extensions", True)
            ):
                core_ids = {
                    normalize_space(row.get("_core_id"))
                    for _, row in core_rows
                    if normalize_space(row.get("_core_id"))
                }

                extension_rows = self._load_extensions(
                    source,
                    extensions,
                    core_ids,
                    diagnostics=diagnostics,
                )

            for source_index, core_row in core_rows:
                core_id = normalize_space(core_row.get("_core_id"))

                raw_record = dict(core_row)
                raw_record["_extensions"] = (
                    extension_rows.get(core_id, {})
                    if core_id
                    else {}
                )
                raw_record["_dwca"] = {
                    "core_row_type": core.row_type,
                    "core_file": core.primary_file,
                    "core_offset": source_index,
                    "archive_path": archive_path.as_posix(),
                    "archive_fingerprint": fingerprint,
                }

                self._prepare_identity(
                    raw_record,
                    core=core,
                    source_index=source_index,
                    fingerprint=fingerprint,
                )

                try:
                    record = self.normalize_record(
                        raw_record,
                        source_path=archive_path,
                        retrieved_at=retrieved_at,
                    )
                except Exception as error:
                    if bool(self.definition.get("strict", False)):
                        raise ProviderError(
                            f"{self.name}: failed to normalize Darwin Core "
                            f"row {source_index}: {error}"
                        ) from error

                    diagnostics.rejected_records += 1
                    continue

                if record is None:
                    diagnostics.rejected_records += 1
                    continue

                self._augment_dwca_extra(
                    record,
                    raw_record,
                    core=core,
                    archive_path=archive_path,
                    fingerprint=fingerprint,
                    eml=eml,
                    diagnostics=diagnostics,
                )
                records.append(record)

        self._last_rejected = diagnostics.rejected_records

        return Batch(
            records=records,
            next_cursor=(
                None
                if exhausted
                else json.dumps(
                    {
                        "offset": next_offset,
                        "fingerprint": fingerprint,
                    },
                    separators=(",", ":"),
                    sort_keys=True,
                )
            ),
            exhausted=exhausted,
            requests=0,
            raw=raw_count,
        )

    def _source_path(self) -> Path:
        configured = normalize_space(
            self.definition.get("path")
            or self.definition.get("archive")
            or self.definition.get("source_path")
        )

        if not configured:
            raise ProviderError(
                "Darwin Core Archive provider requires a path."
            )

        path = Path(configured)

        if not path.is_absolute():
            path = self.repo_root / path

        if not path.exists():
            raise ProviderError(
                f"Darwin Core archive not found: {path}"
            )

        if not path.is_file() and not path.is_dir():
            raise ProviderError(
                f"Darwin Core archive path is invalid: {path}"
            )

        return path

    def _map_fields(
        self,
        raw: Mapping[str, Any],
    ) -> dict[str, Any]:
        """
        Merge Darwin Core defaults with provider-specific mappings without
        mutating the shared provider definition.
        """

        configured = self.definition.get("mapping", {})

        if configured is None:
            configured = {}

        if not isinstance(configured, Mapping):
            raise ProviderError(
                "Darwin Core mapping must be an object."
            )

        merged: dict[str, Any] = dict(self.DEFAULT_MAPPING)
        merged.update(
            {
                str(field): specification
                for field, specification in configured.items()
            }
        )

        mapped: dict[str, Any] = {}

        for field in self.TAXON_FIELDS:
            specification = merged.get(field)

            if specification is None:
                specification = self._default_paths(field)

            value = self._resolve_specification(
                raw,
                specification,
            )

            if value is not _MISSING:
                mapped[field] = value

        if _is_empty(mapped.get("canonical_name")):
            mapped["canonical_name"] = mapped.get("scientific_name")

        return mapped

    def _prepare_identity(
        self,
        raw_record: dict[str, Any],
        *,
        core: ArchiveTable,
        source_index: int,
        fingerprint: str,
    ) -> None:
        """
        Select a stable identity according to archive row type and configured
        identity mode.

        ``auto`` prefers taxonID for taxon cores and occurrenceID or
        materialSampleID for occurrence-like cores. A deterministic fallback is
        generated only when the archive lacks all usable identifiers.
        """

        identity_mode = normalize_space(
            self.definition.get("identity_mode")
        ).casefold() or "auto"

        row_type = local_term_name(core.row_type)

        taxon_id = normalize_space(
            raw_record.get("taxonID")
            or raw_record.get(f"{DWC_TERMS}taxonID")
        )
        occurrence_id = normalize_space(
            raw_record.get("occurrenceID")
            or raw_record.get(f"{DWC_TERMS}occurrenceID")
        )
        material_sample_id = normalize_space(
            raw_record.get("materialSampleID")
            or raw_record.get(f"{DWC_TERMS}materialSampleID")
        )
        event_id = normalize_space(
            raw_record.get("eventID")
            or raw_record.get(f"{DWC_TERMS}eventID")
        )
        core_id = normalize_space(raw_record.get("_core_id"))

        selected = ""

        if identity_mode == "taxon":
            selected = taxon_id or core_id
        elif identity_mode == "occurrence":
            selected = (
                occurrence_id
                or material_sample_id
                or core_id
                or taxon_id
            )
        elif identity_mode == "event":
            selected = event_id or core_id
        else:
            if row_type in {
                local_term_name(value)
                for value in TAXON_ROW_TYPES
            }:
                selected = taxon_id or core_id
            elif row_type in {
                local_term_name(value)
                for value in OCCURRENCE_LIKE_ROW_TYPES
            }:
                selected = (
                    occurrence_id
                    or material_sample_id
                    or core_id
                    or taxon_id
                )
            elif row_type in {
                local_term_name(value)
                for value in EVENT_ROW_TYPES
            }:
                selected = event_id or core_id
            else:
                selected = (
                    taxon_id
                    or occurrence_id
                    or material_sample_id
                    or event_id
                    or core_id
                )

        if not selected:
            selected = (
                f"dwca:{fingerprint[:16]}:"
                f"{core.primary_file}:{source_index}"
            )
            raw_record["_generated_provider_id"] = True

        raw_record["provider_id"] = selected

    def _read_metadata(
        self,
        source: ArchiveSource,
    ) -> dict[str, Any]:
        meta_member = normalize_space(
            self.definition.get("meta_path")
        ) or "meta.xml"

        if source.exists(meta_member):
            return self._parse_meta_xml(
                source.read_bytes(meta_member)
            )

        if bool(self.definition.get("require_meta_xml", False)):
            raise ProviderError(
                "Darwin Core archive requires meta.xml but none was found."
            )

        return self._infer_metadata(source)

    def _read_eml_metadata(
        self,
        source: ArchiveSource,
    ) -> dict[str, Any]:
        eml_member = normalize_space(
            self.definition.get("eml_path")
        ) or "eml.xml"

        if not source.exists(eml_member):
            return {}

        try:
            root = ElementTree.fromstring(
                source.read_bytes(eml_member)
            )
        except ElementTree.ParseError as error:
            if bool(self.definition.get("strict", False)):
                raise ProviderError(
                    f"Invalid Darwin Core eml.xml: {error}"
                ) from error

            return {
                "parse_error": str(error),
            }

        dataset = self._descendant(root, "dataset") or root

        return {
            "title": self._descendant_text(dataset, "title"),
            "abstract": self._paragraph_text(
                self._descendant(dataset, "abstract")
            ),
            "language": self._descendant_text(dataset, "language"),
            "publication_date": self._descendant_text(
                dataset,
                "pubDate",
            ),
            "intellectual_rights": self._paragraph_text(
                self._descendant(
                    dataset,
                    "intellectualRights",
                )
            ),
            "creators": self._parse_eml_people(
                dataset,
                "creator",
            ),
            "metadata_providers": self._parse_eml_people(
                dataset,
                "metadataProvider",
            ),
            "contacts": self._parse_eml_people(
                dataset,
                "contact",
            ),
            "associated_parties": self._parse_eml_people(
                dataset,
                "associatedParty",
            ),
            "geographic_coverage": self._parse_geographic_coverage(
                dataset
            ),
            "temporal_coverage": self._parse_temporal_coverage(
                dataset
            ),
            "taxonomic_coverage": self._parse_taxonomic_coverage(
                dataset
            ),
            "methods": self._paragraph_text(
                self._descendant(dataset, "methods")
            ),
            "project": self._parse_project(dataset),
        }

    def _parse_meta_xml(
        self,
        xml_bytes: bytes,
    ) -> dict[str, Any]:
        try:
            root = ElementTree.fromstring(xml_bytes)
        except ElementTree.ParseError as error:
            raise ProviderError(
                f"Invalid Darwin Core meta.xml: {error}"
            ) from error

        core_element = self._find_child(root, "core")

        if core_element is None:
            raise ProviderError(
                "Darwin Core meta.xml does not define a core table."
            )

        core = self._parse_table(
            core_element,
            role="core",
        )

        extensions = [
            self._parse_table(
                element,
                role="extension",
            )
            for element in self._find_children(
                root,
                "extension",
            )
        ]

        return {
            "core": core,
            "extensions": extensions,
        }

    def _parse_table(
        self,
        element: ElementTree.Element,
        *,
        role: str,
    ) -> ArchiveTable:
        files: list[str] = []
        files_element = self._find_child(
            element,
            "files",
        )

        if files_element is not None:
            for location in self._find_children(
                files_element,
                "location",
            ):
                text = clean_xml_text(location.text)

                if text:
                    files.append(normalize_member_name(text))

        fields: list[ArchiveField] = []

        for field_element in self._find_children(
            element,
            "field",
        ):
            index = safe_int(
                field_element.attrib.get("index"),
                -1,
            )
            term = normalize_space(
                field_element.attrib.get("term")
            )

            if index < 0 or not term:
                continue

            fields.append(
                ArchiveField(
                    index=index,
                    term=term,
                    default=normalize_space(
                        field_element.attrib.get("default")
                    ),
                )
            )

        id_index: int | None = None
        coreid_index: int | None = None

        id_element = self._find_child(element, "id")

        if id_element is not None:
            parsed = safe_int(
                id_element.attrib.get("index"),
                -1,
            )
            id_index = parsed if parsed >= 0 else None

        coreid_element = self._find_child(
            element,
            "coreid",
        )

        if coreid_element is not None:
            parsed = safe_int(
                coreid_element.attrib.get("index"),
                -1,
            )
            coreid_index = parsed if parsed >= 0 else None

        delimiter = decode_xml_character(
            element.attrib.get("fieldsTerminatedBy"),
            "\t",
        )
        enclosure = decode_xml_character(
            element.attrib.get("fieldsEnclosedBy"),
            '"',
        )

        if len(delimiter) != 1:
            raise ProviderError(
                f"Darwin Core {role} delimiter must be one character; "
                f"received {delimiter!r}."
            )

        if enclosure and len(enclosure) != 1:
            raise ProviderError(
                f"Darwin Core {role} enclosure must be one character; "
                f"received {enclosure!r}."
            )

        return ArchiveTable(
            role=role,
            row_type=normalize_space(
                element.attrib.get("rowType")
            ),
            files=tuple(files),
            fields=tuple(
                sorted(
                    fields,
                    key=lambda field: field.index,
                )
            ),
            id_index=id_index,
            coreid_index=coreid_index,
            ignore_header_lines=max(
                0,
                safe_int(
                    element.attrib.get("ignoreHeaderLines"),
                    0,
                ),
            ),
            fields_terminated_by=delimiter,
            lines_terminated_by=decode_xml_character(
                element.attrib.get("linesTerminatedBy"),
                "\n",
            ),
            fields_enclosed_by=enclosure,
            encoding=normalize_space(
                element.attrib.get("encoding")
            ) or "utf-8",
        )

    def _infer_metadata(
        self,
        source: ArchiveSource,
    ) -> dict[str, Any]:
        configured_core = normalize_space(
            self.definition.get("core_file")
        )

        candidates = [
            configured_core,
            "taxon.txt",
            "occurrence.txt",
            "event.txt",
            "materialsample.txt",
            "core.txt",
            "taxa.txt",
            "taxon.csv",
            "occurrence.csv",
            "event.csv",
        ]

        core_file = next(
            (
                candidate
                for candidate in candidates
                if candidate and source.exists(candidate)
            ),
            "",
        )

        if not core_file:
            core_file = next(
                (
                    member
                    for member in source.members()
                    if Path(member).suffix.casefold()
                    in {".txt", ".tsv", ".csv", ".psv"}
                ),
                "",
            )

        if not core_file:
            raise ProviderError(
                "Unable to infer Darwin Core core table."
            )

        suffix = Path(core_file).suffix.casefold()
        delimiter = (
            ","
            if suffix == ".csv"
            else "|"
            if suffix == ".psv"
            else "\t"
        )
        encoding = normalize_space(
            self.definition.get("encoding")
        ) or "utf-8"

        with source.open_text(
            core_file,
            encoding=encoding,
            newline="",
        ) as handle:
            reader = csv.reader(
                handle,
                delimiter=delimiter,
            )

            try:
                header = next(reader)
            except StopIteration as error:
                raise ProviderError(
                    f"Darwin Core core file is empty: {core_file}"
                ) from error

        fields = tuple(
            ArchiveField(
                index=index,
                term=(
                    normalize_space(value)
                    if "://" in normalize_space(value)
                    else f"{DWC_TERMS}{normalize_space(value)}"
                ),
            )
            for index, value in enumerate(header)
            if normalize_space(value)
        )

        id_index = self._field_index(
            fields,
            {
                "taxonID",
                "occurrenceID",
                "scientificNameID",
                "materialSampleID",
                "eventID",
                "id",
            },
        )

        inferred_row_type = normalize_space(
            self.definition.get("row_type")
        )

        if not inferred_row_type:
            lower_name = Path(core_file).name.casefold()

            if "occurrence" in lower_name:
                inferred_row_type = f"{DWC_TERMS}Occurrence"
            elif "event" in lower_name:
                inferred_row_type = f"{DWC_TERMS}Event"
            elif "material" in lower_name:
                inferred_row_type = f"{DWC_TERMS}MaterialSample"
            else:
                inferred_row_type = f"{DWC_TERMS}Taxon"

        return {
            "core": ArchiveTable(
                role="core",
                row_type=inferred_row_type,
                files=(core_file,),
                fields=fields,
                id_index=id_index,
                coreid_index=None,
                ignore_header_lines=1,
                fields_terminated_by=delimiter,
                lines_terminated_by="\n",
                fields_enclosed_by='"',
                encoding=encoding,
            ),
            "extensions": [],
        }

    def _validate_table_definition(
        self,
        source: ArchiveSource,
        table: ArchiveTable,
        *,
        strict: bool,
    ) -> None:
        if not table.files:
            if strict:
                raise ProviderError(
                    f"Darwin Core {table.role} table defines no files."
                )
            return

        missing = [
            file_name
            for file_name in table.files
            if not source.exists(file_name)
        ]

        if missing and strict:
            raise ProviderError(
                f"Darwin Core {table.role} table references missing "
                f"files: {missing}"
            )

        indices = [field.index for field in table.fields]

        if len(indices) != len(set(indices)) and strict:
            raise ProviderError(
                f"Darwin Core {table.role} table contains duplicate "
                "field indexes."
            )

        if (
            table.role == "extension"
            and table.coreid_index is None
            and strict
        ):
            raise ProviderError(
                "Darwin Core extension does not define coreid."
            )

    def _iter_table_rows(
        self,
        source: ArchiveSource,
        table: ArchiveTable,
        *,
        start_offset: int,
    ) -> Iterable[tuple[int, dict[str, Any], bool]]:
        logical_index = 0
        expected_columns = self._expected_column_count(table)

        for file_name in table.files:
            if not source.exists(file_name):
                continue

            with source.open_text(
                file_name,
                encoding=table.encoding,
                newline="",
            ) as handle:
                reader = csv.reader(
                    handle,
                    delimiter=table.fields_terminated_by,
                    quotechar=(
                        table.fields_enclosed_by
                        if table.fields_enclosed_by
                        else None
                    ),
                    quoting=(
                        csv.QUOTE_MINIMAL
                        if table.fields_enclosed_by
                        else csv.QUOTE_NONE
                    ),
                    strict=False,
                )

                for _ in range(table.ignore_header_lines):
                    next(reader, None)

                for row in reader:
                    if logical_index < start_offset:
                        logical_index += 1
                        continue

                    malformed = bool(
                        expected_columns
                        and len(row) < expected_columns
                    )

                    normalized = self._row_to_record(
                        row,
                        table,
                    )
                    normalized["_source_file"] = file_name
                    normalized["_row_malformed"] = malformed
                    normalized["_column_count"] = len(row)

                    yield logical_index, normalized, malformed
                    logical_index += 1

    def _row_to_record(
        self,
        row: list[str],
        table: ArchiveTable,
    ) -> dict[str, Any]:
        record: dict[str, Any] = {}

        if table.id_index is not None:
            record["_core_id"] = self._column(
                row,
                table.id_index,
            )

        if table.coreid_index is not None:
            record["_core_id"] = self._column(
                row,
                table.coreid_index,
            )

        for field in table.fields:
            value = self._column(
                row,
                field.index,
            )

            if not value and field.default:
                value = field.default

            record[field.term] = value

            local_name = local_term_name(field.term)

            if local_name and local_name not in record:
                record[local_name] = value

        return record

    def _load_extensions(
        self,
        source: ArchiveSource,
        extensions: list[ArchiveTable],
        core_ids: set[str],
        *,
        diagnostics: ArchiveDiagnostics,
    ) -> dict[str, dict[str, list[dict[str, Any]]]]:
        result: dict[str, dict[str, list[dict[str, Any]]]] = {}
        allowlist = {
            normalize_space(value)
            for value in _coerce_list(
                self.definition.get("extension_allowlist")
            )
            if normalize_space(value)
        }
        denylist = {
            normalize_space(value)
            for value in _coerce_list(
                self.definition.get("extension_denylist")
            )
            if normalize_space(value)
        }
        max_rows = max(
            0,
            safe_int(
                self.definition.get(
                    "max_extension_rows_per_core",
                    1000,
                ),
                1000,
            ),
        )

        for extension in extensions:
            extension_name = extension.extension_name

            if allowlist and extension_name not in allowlist:
                continue

            if extension_name in denylist:
                continue

            for _, row, malformed in self._iter_table_rows(
                source,
                extension,
                start_offset=0,
            ):
                if malformed:
                    diagnostics.malformed_extension_rows += 1

                core_id = normalize_space(row.get("_core_id"))

                if not core_id or core_id not in core_ids:
                    continue

                bucket = result.setdefault(
                    core_id,
                    {},
                ).setdefault(
                    extension_name,
                    [],
                )

                if max_rows and len(bucket) >= max_rows:
                    diagnostics.truncated_extension_rows += 1
                    continue

                bucket.append(row)

        return result

    def _augment_dwca_extra(
        self,
        record: Taxon,
        raw_record: Mapping[str, Any],
        *,
        core: ArchiveTable,
        archive_path: Path,
        fingerprint: str,
        eml: Mapping[str, Any],
        diagnostics: ArchiveDiagnostics,
    ) -> None:
        extra = getattr(record, "extra", None)

        if not isinstance(extra, dict):
            return

        extensions = raw_record.get("_extensions", {})

        extra["darwin_core"] = {
            "archive": archive_path.as_posix(),
            "archive_fingerprint": fingerprint,
            "core_file": core.primary_file,
            "core_row_type": core.row_type,
            "core_row_type_name": local_term_name(core.row_type),
            "core_id": normalize_space(
                raw_record.get("_core_id")
            ),
            "generated_provider_id": bool(
                raw_record.get("_generated_provider_id")
            ),
            "source_file": normalize_space(
                raw_record.get("_source_file")
            ),
            "column_count": safe_int(
                raw_record.get("_column_count"),
                0,
            ),
            "row_malformed": bool(
                raw_record.get("_row_malformed")
            ),
            "extensions": extensions,
            "extension_counts": {
                name: len(rows)
                for name, rows in (
                    extensions.items()
                    if isinstance(extensions, Mapping)
                    else []
                )
            },
            "terms": {
                key: value
                for key, value in raw_record.items()
                if isinstance(key, str) and "://" in key
            },
            "eml": dict(eml),
            "diagnostics": diagnostics.as_dict(),
            "parsed_at": utc_now(),
        }

        extra["occurrence"] = self._occurrence_metadata(raw_record)
        extra["event"] = self._event_metadata(raw_record)
        extra["location"] = self._location_metadata(raw_record)
        extra["identification"] = self._identification_metadata(raw_record)
        extra["geological_context"] = self._geological_metadata(raw_record)
        extra["collection"] = self._collection_metadata(raw_record)
        extra["rights"] = self._rights_metadata(raw_record)

    @staticmethod
    def _occurrence_metadata(
        row: Mapping[str, Any],
    ) -> dict[str, Any]:
        return {
            "occurrence_id": normalize_space(row.get("occurrenceID")),
            "basis_of_record": normalize_space(
                row.get("basisOfRecord")
            ),
            "occurrence_status": normalize_space(
                row.get("occurrenceStatus")
            ),
            "individual_count": Provider._optional_int(
                row.get("individualCount")
            ),
            "organism_quantity": Provider._optional_float(
                row.get("organismQuantity")
            ),
            "organism_quantity_type": normalize_space(
                row.get("organismQuantityType")
            ),
            "sex": normalize_space(row.get("sex")),
            "life_stage": normalize_space(row.get("lifeStage")),
            "reproductive_condition": normalize_space(
                row.get("reproductiveCondition")
            ),
            "behavior": normalize_space(row.get("behavior")),
            "establishment_means": normalize_space(
                row.get("establishmentMeans")
            ),
            "degree_of_establishment": normalize_space(
                row.get("degreeOfEstablishment")
            ),
            "pathway": normalize_space(row.get("pathway")),
            "recorded_by": normalize_space(row.get("recordedBy")),
            "recorded_by_id": normalize_space(
                row.get("recordedByID")
            ),
            "associated_media": normalize_space(
                row.get("associatedMedia")
            ),
            "associated_references": normalize_space(
                row.get("associatedReferences")
            ),
            "associated_sequences": normalize_space(
                row.get("associatedSequences")
            ),
            "catalog_number": normalize_space(
                row.get("catalogNumber")
            ),
            "record_number": normalize_space(
                row.get("recordNumber")
            ),
        }

    @staticmethod
    def _event_metadata(
        row: Mapping[str, Any],
    ) -> dict[str, Any]:
        return {
            "event_id": normalize_space(row.get("eventID")),
            "parent_event_id": normalize_space(
                row.get("parentEventID")
            ),
            "field_number": normalize_space(row.get("fieldNumber")),
            "event_date": normalize_space(row.get("eventDate")),
            "event_time": normalize_space(row.get("eventTime")),
            "start_day_of_year": Provider._optional_int(
                row.get("startDayOfYear")
            ),
            "end_day_of_year": Provider._optional_int(
                row.get("endDayOfYear")
            ),
            "year": Provider._optional_int(row.get("year")),
            "month": Provider._optional_int(row.get("month")),
            "day": Provider._optional_int(row.get("day")),
            "verbatim_event_date": normalize_space(
                row.get("verbatimEventDate")
            ),
            "habitat": normalize_space(row.get("habitat")),
            "sampling_protocol": normalize_space(
                row.get("samplingProtocol")
            ),
            "sample_size_value": Provider._optional_float(
                row.get("sampleSizeValue")
            ),
            "sample_size_unit": normalize_space(
                row.get("sampleSizeUnit")
            ),
            "sampling_effort": normalize_space(
                row.get("samplingEffort")
            ),
            "field_notes": normalize_space(row.get("fieldNotes")),
        }

    @staticmethod
    def _location_metadata(
        row: Mapping[str, Any],
    ) -> dict[str, Any]:
        return {
            "location_id": normalize_space(row.get("locationID")),
            "higher_geography_id": normalize_space(
                row.get("higherGeographyID")
            ),
            "higher_geography": normalize_space(
                row.get("higherGeography")
            ),
            "continent": normalize_space(row.get("continent")),
            "water_body": normalize_space(row.get("waterBody")),
            "island_group": normalize_space(row.get("islandGroup")),
            "island": normalize_space(row.get("island")),
            "country": normalize_space(row.get("country")),
            "country_code": normalize_space(row.get("countryCode")),
            "state_province": normalize_space(
                row.get("stateProvince")
            ),
            "county": normalize_space(row.get("county")),
            "municipality": normalize_space(row.get("municipality")),
            "locality": normalize_space(row.get("locality")),
            "verbatim_locality": normalize_space(
                row.get("verbatimLocality")
            ),
            "decimal_latitude": Provider._optional_float(
                row.get("decimalLatitude")
            ),
            "decimal_longitude": Provider._optional_float(
                row.get("decimalLongitude")
            ),
            "geodetic_datum": normalize_space(
                row.get("geodeticDatum")
            ),
            "coordinate_uncertainty_m": Provider._optional_float(
                row.get("coordinateUncertaintyInMeters")
            ),
            "coordinate_precision": Provider._optional_float(
                row.get("coordinatePrecision")
            ),
            "georeferenced_by": normalize_space(
                row.get("georeferencedBy")
            ),
            "georeferenced_date": normalize_space(
                row.get("georeferencedDate")
            ),
            "georeference_protocol": normalize_space(
                row.get("georeferenceProtocol")
            ),
            "georeference_sources": normalize_space(
                row.get("georeferenceSources")
            ),
            "georeference_verification_status": normalize_space(
                row.get("georeferenceVerificationStatus")
            ),
            "minimum_elevation_m": Provider._optional_float(
                row.get("minimumElevationInMeters")
            ),
            "maximum_elevation_m": Provider._optional_float(
                row.get("maximumElevationInMeters")
            ),
            "minimum_depth_m": Provider._optional_float(
                row.get("minimumDepthInMeters")
            ),
            "maximum_depth_m": Provider._optional_float(
                row.get("maximumDepthInMeters")
            ),
        }

    @staticmethod
    def _identification_metadata(
        row: Mapping[str, Any],
    ) -> dict[str, Any]:
        return {
            "identification_id": normalize_space(
                row.get("identificationID")
            ),
            "identified_by": normalize_space(
                row.get("identifiedBy")
            ),
            "identified_by_id": normalize_space(
                row.get("identifiedByID")
            ),
            "date_identified": normalize_space(
                row.get("dateIdentified")
            ),
            "identification_references": normalize_space(
                row.get("identificationReferences")
            ),
            "identification_remarks": normalize_space(
                row.get("identificationRemarks")
            ),
            "identification_qualifier": normalize_space(
                row.get("identificationQualifier")
            ),
            "type_status": normalize_space(row.get("typeStatus")),
            "verification_status": normalize_space(
                row.get("identificationVerificationStatus")
            ),
            "verbatim_identification": normalize_space(
                row.get("verbatimIdentification")
            ),
        }

    @staticmethod
    def _geological_metadata(
        row: Mapping[str, Any],
    ) -> dict[str, Any]:
        return {
            "geological_context_id": normalize_space(
                row.get("geologicalContextID")
            ),
            "earliest_eon": normalize_space(
                row.get("earliestEonOrLowestEonothem")
            ),
            "latest_eon": normalize_space(
                row.get("latestEonOrHighestEonothem")
            ),
            "earliest_era": normalize_space(
                row.get("earliestEraOrLowestErathem")
            ),
            "latest_era": normalize_space(
                row.get("latestEraOrHighestErathem")
            ),
            "earliest_period": normalize_space(
                row.get("earliestPeriodOrLowestSystem")
            ),
            "latest_period": normalize_space(
                row.get("latestPeriodOrHighestSystem")
            ),
            "earliest_epoch": normalize_space(
                row.get("earliestEpochOrLowestSeries")
            ),
            "latest_epoch": normalize_space(
                row.get("latestEpochOrHighestSeries")
            ),
            "earliest_age": normalize_space(
                row.get("earliestAgeOrLowestStage")
            ),
            "latest_age": normalize_space(
                row.get("latestAgeOrHighestStage")
            ),
            "formation": normalize_space(row.get("formation")),
            "member": normalize_space(row.get("member")),
            "bed": normalize_space(row.get("bed")),
            "group": normalize_space(row.get("group")),
        }

    @staticmethod
    def _collection_metadata(
        row: Mapping[str, Any],
    ) -> dict[str, Any]:
        return {
            "institution_id": normalize_space(
                row.get("institutionID")
            ),
            "institution_code": normalize_space(
                row.get("institutionCode")
            ),
            "collection_id": normalize_space(
                row.get("collectionID")
            ),
            "collection_code": normalize_space(
                row.get("collectionCode")
            ),
            "dataset_id": normalize_space(row.get("datasetID")),
            "dataset_name": normalize_space(row.get("datasetName")),
            "owner_institution_code": normalize_space(
                row.get("ownerInstitutionCode")
            ),
            "material_sample_id": normalize_space(
                row.get("materialSampleID")
            ),
            "preparations": normalize_space(row.get("preparations")),
            "disposition": normalize_space(row.get("disposition")),
        }

    @staticmethod
    def _rights_metadata(
        row: Mapping[str, Any],
    ) -> dict[str, Any]:
        return {
            "license": normalize_space(
                row.get("license")
                or row.get(f"{DCTERMS}license")
            ),
            "rights": normalize_space(
                row.get("rights")
                or row.get(f"{DCTERMS}rights")
            ),
            "rights_holder": normalize_space(
                row.get("rightsHolder")
                or row.get(f"{DCTERMS}rightsHolder")
            ),
            "access_rights": normalize_space(
                row.get("accessRights")
                or row.get(f"{DCTERMS}accessRights")
            ),
            "bibliographic_citation": normalize_space(
                row.get("bibliographicCitation")
                or row.get(f"{DCTERMS}bibliographicCitation")
            ),
            "information_withheld": normalize_space(
                row.get("informationWithheld")
            ),
            "data_generalizations": normalize_space(
                row.get("dataGeneralizations")
            ),
        }

    def _archive_fingerprint(self, path: Path) -> str:
        digest = sha256()

        if path.is_file():
            stat_result = path.stat()
            digest.update(path.name.encode("utf-8"))
            digest.update(str(stat_result.st_size).encode("ascii"))
            digest.update(
                str(stat_result.st_mtime_ns).encode("ascii")
            )

            with path.open("rb") as handle:
                first = handle.read(1024 * 1024)
                digest.update(first)

                if stat_result.st_size > 1024 * 1024:
                    handle.seek(max(0, stat_result.st_size - 1024 * 1024))
                    digest.update(handle.read(1024 * 1024))
        else:
            for candidate in sorted(
                (
                    item
                    for item in path.rglob("*")
                    if item.is_file()
                ),
                key=lambda item: item.relative_to(path).as_posix(),
            ):
                relative = candidate.relative_to(path).as_posix()
                stat_result = candidate.stat()
                digest.update(relative.encode("utf-8"))
                digest.update(str(stat_result.st_size).encode("ascii"))
                digest.update(
                    str(stat_result.st_mtime_ns).encode("ascii")
                )

        return digest.hexdigest()

    @staticmethod
    def _expected_column_count(table: ArchiveTable) -> int:
        indices = [
            field.index
            for field in table.fields
        ]

        if table.id_index is not None:
            indices.append(table.id_index)

        if table.coreid_index is not None:
            indices.append(table.coreid_index)

        return max(indices, default=-1) + 1

    @staticmethod
    def _column(
        row: Sequence[str],
        index: int,
    ) -> str:
        if index < 0 or index >= len(row):
            return ""

        return normalize_space(row[index])

    @staticmethod
    def _field_index(
        fields: tuple[ArchiveField, ...],
        names: set[str],
    ) -> int | None:
        for field in fields:
            if local_term_name(field.term) in names:
                return field.index

        return None

    @staticmethod
    def _find_child(
        element: ElementTree.Element,
        local_name: str,
    ) -> ElementTree.Element | None:
        for child in list(element):
            if child.tag.rsplit("}", 1)[-1] == local_name:
                return child

        return None

    @staticmethod
    def _find_children(
        element: ElementTree.Element,
        local_name: str,
    ) -> list[ElementTree.Element]:
        return [
            child
            for child in list(element)
            if child.tag.rsplit("}", 1)[-1] == local_name
        ]

    @staticmethod
    def _descendant(
        element: ElementTree.Element,
        local_name: str,
    ) -> ElementTree.Element | None:
        for candidate in element.iter():
            if candidate.tag.rsplit("}", 1)[-1] == local_name:
                return candidate

        return None

    @classmethod
    def _descendant_text(
        cls,
        element: ElementTree.Element,
        local_name: str,
    ) -> str:
        candidate = cls._descendant(element, local_name)

        if candidate is None:
            return ""

        return clean_xml_text(
            " ".join(candidate.itertext())
        )

    @staticmethod
    def _paragraph_text(
        element: ElementTree.Element | None,
    ) -> str:
        if element is None:
            return ""

        return clean_xml_text(
            " ".join(element.itertext())
        )

    @classmethod
    def _parse_eml_people(
        cls,
        dataset: ElementTree.Element,
        local_name: str,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for candidate in dataset.iter():
            if candidate.tag.rsplit("}", 1)[-1] != local_name:
                continue

            individual = cls._descendant(
                candidate,
                "individualName",
            )

            given = (
                cls._descendant_text(individual, "givenName")
                if individual is not None
                else ""
            )
            surname = (
                cls._descendant_text(individual, "surName")
                if individual is not None
                else ""
            )

            result.append(
                {
                    "name": normalize_space(
                        f"{given} {surname}"
                    ),
                    "organization": cls._descendant_text(
                        candidate,
                        "organizationName",
                    ),
                    "position": cls._descendant_text(
                        candidate,
                        "positionName",
                    ),
                    "email": cls._descendant_text(
                        candidate,
                        "electronicMailAddress",
                    ),
                    "phone": cls._descendant_text(
                        candidate,
                        "phone",
                    ),
                    "online_url": cls._descendant_text(
                        candidate,
                        "onlineUrl",
                    ),
                    "user_id": cls._descendant_text(
                        candidate,
                        "userId",
                    ),
                }
            )

        return result

    @classmethod
    def _parse_geographic_coverage(
        cls,
        dataset: ElementTree.Element,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for candidate in dataset.iter():
            if (
                candidate.tag.rsplit("}", 1)[-1]
                != "geographicCoverage"
            ):
                continue

            result.append(
                {
                    "description": cls._descendant_text(
                        candidate,
                        "geographicDescription",
                    ),
                    "west": cls._optional_float(
                        cls._descendant_text(
                            candidate,
                            "westBoundingCoordinate",
                        )
                    ),
                    "east": cls._optional_float(
                        cls._descendant_text(
                            candidate,
                            "eastBoundingCoordinate",
                        )
                    ),
                    "north": cls._optional_float(
                        cls._descendant_text(
                            candidate,
                            "northBoundingCoordinate",
                        )
                    ),
                    "south": cls._optional_float(
                        cls._descendant_text(
                            candidate,
                            "southBoundingCoordinate",
                        )
                    ),
                }
            )

        return result

    @classmethod
    def _parse_temporal_coverage(
        cls,
        dataset: ElementTree.Element,
    ) -> list[dict[str, str]]:
        result: list[dict[str, str]] = []

        for candidate in dataset.iter():
            if (
                candidate.tag.rsplit("}", 1)[-1]
                != "temporalCoverage"
            ):
                continue

            result.append(
                {
                    "begin": cls._descendant_text(
                        candidate,
                        "beginDate",
                    ),
                    "end": cls._descendant_text(
                        candidate,
                        "endDate",
                    ),
                    "single_date": cls._descendant_text(
                        candidate,
                        "singleDateTime",
                    ),
                }
            )

        return result

    @classmethod
    def _parse_taxonomic_coverage(
        cls,
        dataset: ElementTree.Element,
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []

        for candidate in dataset.iter():
            if (
                candidate.tag.rsplit("}", 1)[-1]
                != "taxonomicCoverage"
            ):
                continue

            classifications: list[dict[str, str]] = []

            for classification in candidate.iter():
                if (
                    classification.tag.rsplit("}", 1)[-1]
                    != "taxonomicClassification"
                ):
                    continue

                classifications.append(
                    {
                        "rank": cls._descendant_text(
                            classification,
                            "taxonRankName",
                        ),
                        "name": cls._descendant_text(
                            classification,
                            "taxonRankValue",
                        ),
                        "common_name": cls._descendant_text(
                            classification,
                            "commonName",
                        ),
                    }
                )

            result.append(
                {
                    "description": cls._descendant_text(
                        candidate,
                        "generalTaxonomicCoverage",
                    ),
                    "classifications": classifications,
                }
            )

        return result

    @classmethod
    def _parse_project(
        cls,
        dataset: ElementTree.Element,
    ) -> dict[str, Any]:
        project = cls._descendant(dataset, "project")

        if project is None:
            return {}

        return {
            "title": cls._descendant_text(project, "title"),
            "personnel": cls._parse_eml_people(
                project,
                "personnel",
            ),
            "funding": cls._paragraph_text(
                cls._descendant(project, "funding")
            ),
            "study_area_description": cls._paragraph_text(
                cls._descendant(
                    project,
                    "studyAreaDescription",
                )
            ),
            "design_description": cls._paragraph_text(
                cls._descendant(
                    project,
                    "designDescription",
                )
            ),
        }

    @staticmethod
    def _decode_dwca_cursor(
        cursor: str | None,
        *,
        fingerprint: str,
    ) -> dict[str, Any]:
        if not cursor:
            return {
                "offset": 0,
                "fingerprint": fingerprint,
            }

        try:
            parsed = json.loads(cursor)

            if isinstance(parsed, Mapping):
                offset = int(parsed.get("offset", 0))
                saved_fingerprint = normalize_space(
                    parsed.get("fingerprint")
                )
            else:
                offset = int(parsed)
                saved_fingerprint = ""
        except (json.JSONDecodeError, TypeError, ValueError):
            try:
                offset = int(cursor)
                saved_fingerprint = ""
            except (TypeError, ValueError) as error:
                raise ProviderError(
                    f"Invalid Darwin Core cursor: {cursor!r}."
                ) from error

        if offset < 0:
            raise ProviderError(
                "Darwin Core cursor must be non-negative."
            )

        if saved_fingerprint and saved_fingerprint != fingerprint:
            raise ProviderError(
                "Darwin Core archive changed since the cursor was saved. "
                "Reset provider state before resuming this archive."
            )

        return {
            "offset": offset,
            "fingerprint": fingerprint,
        }

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
