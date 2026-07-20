#!/usr/bin/env python3
"""
Speciedex.org
static/tools/providers/darwin_core_archive.py

Darwin Core Archive provider plug-in.

This adapter ingests Darwin Core Archives directly from ZIP files or extracted
archive directories. It reads ``meta.xml`` when present, maps the archive core
into the shared Speciedex Taxon contract, optionally joins extension rows by
core identifier, preserves Darwin Core terms, and supports resumable batch
processing.

Supported archive features:

- ZIP archives and extracted directories.
- ``meta.xml`` core and extension definitions.
- CSV, TSV, and custom single-character delimiters.
- Headered and index-based term mappings.
- Core row types including Taxon, Occurrence, and Checklist records.
- Extension joins by ``coreid``.
- Declarative field overrides through providers.json.
- Defaults, transforms, filters, and computed fields inherited from
  GenericJSONLProvider normalization logic.
- Complete raw core and extension preservation.
- Resumable core-row cursors.

Example providers.json entry:

    {
      "name": "darwin_core_archive",
      "adapter": "darwin_core_archive",
      "path": "static/data/providers/example/example-dwca.zip",
      "join_extensions": true,
      "mapping": {
        "provider_id": [
          "http://rs.tdwg.org/dwc/terms/taxonID",
          "http://rs.tdwg.org/dwc/terms/scientificNameID",
          "http://rs.tdwg.org/dwc/terms/occurrenceID"
        ],
        "scientific_name": [
          "http://rs.tdwg.org/dwc/terms/scientificName"
        ]
      }
    }

Copyright (c) 2026 ZZX-Laboratories
Licensed under the MIT License.
"""

from __future__ import annotations

import csv
import io
import json
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, TextIO
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
    _coerce_list,
    _is_empty,
)


DWC_NS = "http://rs.tdwg.org/dwc/text/"
DWC_TERMS = "http://rs.tdwg.org/dwc/terms/"
DCTERMS = "http://purl.org/dc/terms/"

_LOCAL_NAME = re.compile(r"[^/#]+$")


def local_term_name(term: str) -> str:
    """Return the terminal fragment of a Darwin Core or Dublin Core URI."""

    match = _LOCAL_NAME.search(normalize_space(term))
    return match.group(0) if match else normalize_space(term)


def decode_xml_character(value: str | None, default: str) -> str:
    """Decode escaped delimiter, quote, and line-ending values from meta.xml."""

    if value is None or value == "":
        return default

    replacements = {
        r"\t": "\t",
        r"\n": "\n",
        r"\r": "\r",
        r"\"": '"',
        r"\'": "'",
        r"\\": "\\",
    }

    return replacements.get(value, value)


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


class ArchiveSource:
    """Uniform reader for ZIP archives and extracted directories."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._zip: zipfile.ZipFile | None = None

        if path.is_file():
            if not zipfile.is_zipfile(path):
                raise ProviderError(
                    f"Darwin Core archive is not a valid ZIP: {path}"
                )

            self._zip = zipfile.ZipFile(path, "r")
        elif not path.is_dir():
            raise ProviderError(
                f"Darwin Core archive path is invalid: {path}"
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
        normalized = member.replace("\\", "/").lstrip("./")

        if self._zip is not None:
            names = {
                name.replace("\\", "/").lstrip("./")
                for name in self._zip.namelist()
            }
            return normalized in names

        return (self.path / normalized).exists()

    def read_bytes(self, member: str) -> bytes:
        normalized = member.replace("\\", "/").lstrip("./")

        if self._zip is not None:
            try:
                return self._zip.read(normalized)
            except KeyError as error:
                raise ProviderError(
                    f"Darwin Core archive member not found: {member}"
                ) from error

        file_path = self.path / normalized

        if not file_path.exists():
            raise ProviderError(
                f"Darwin Core archive member not found: {file_path}"
            )

        return file_path.read_bytes()

    def open_text(
        self,
        member: str,
        *,
        encoding: str,
        newline: str = "",
    ) -> TextIO:
        normalized = member.replace("\\", "/").lstrip("./")

        if self._zip is not None:
            try:
                binary = self._zip.open(normalized, "r")
            except KeyError as error:
                raise ProviderError(
                    f"Darwin Core archive member not found: {member}"
                ) from error

            return io.TextIOWrapper(
                binary,
                encoding=encoding,
                newline=newline,
            )

        file_path = self.path / normalized

        if not file_path.exists():
            raise ProviderError(
                f"Darwin Core archive member not found: {file_path}"
            )

        return file_path.open(
            "r",
            encoding=encoding,
            newline=newline,
        )

    def members(self) -> list[str]:
        if self._zip is not None:
            return self._zip.namelist()

        return [
            path.relative_to(self.path).as_posix()
            for path in self.path.rglob("*")
            if path.is_file()
        ]


class Provider(GenericJSONLProvider):
    """Darwin Core Archive provider."""

    PROVIDER_NAME = "darwin_core_archive"

    DEFAULT_MAPPING = {
        "provider_id": [
            f"{DWC_TERMS}taxonID",
            f"{DWC_TERMS}scientificNameID",
            f"{DWC_TERMS}occurrenceID",
            "taxonID",
            "scientificNameID",
            "occurrenceID",
            "id",
        ],
        "scientific_name": [
            f"{DWC_TERMS}scientificName",
            f"{DWC_TERMS}acceptedNameUsage",
            "scientificName",
            "acceptedNameUsage",
        ],
        "canonical_name": [
            f"{DWC_TERMS}genericName",
            f"{DWC_TERMS}scientificName",
            "canonicalName",
            "scientificName",
        ],
        "rank": [
            f"{DWC_TERMS}taxonRank",
            "taxonRank",
        ],
        "status": [
            f"{DWC_TERMS}taxonomicStatus",
            f"{DWC_TERMS}nomenclaturalStatus",
            "taxonomicStatus",
            "nomenclaturalStatus",
        ],
        "authorship": [
            f"{DWC_TERMS}scientificNameAuthorship",
            "scientificNameAuthorship",
        ],
        "kingdom": [
            f"{DWC_TERMS}kingdom",
            "kingdom",
        ],
        "phylum": [
            f"{DWC_TERMS}phylum",
            "phylum",
        ],
        "class_name": [
            f"{DWC_TERMS}class",
            "class",
        ],
        "order": [
            f"{DWC_TERMS}order",
            "order",
        ],
        "family": [
            f"{DWC_TERMS}family",
            "family",
        ],
        "genus": [
            f"{DWC_TERMS}genus",
            "genus",
        ],
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
        cursor = self._decode_dwca_cursor(self.cursor)
        page_size = self._page_size()
        retrieved_at = now()

        records: list[Taxon] = []
        raw_count = 0
        rejected_count = 0
        next_offset = cursor["offset"]
        exhausted = True

        with ArchiveSource(archive_path) as source:
            metadata = self._read_metadata(source)
            core = metadata["core"]
            extensions = metadata["extensions"]

            core_rows: list[tuple[int, dict[str, Any]]] = []

            for source_index, row in self._iter_table_rows(
                source,
                core,
                start_offset=cursor["offset"],
            ):
                if raw_count >= page_size:
                    exhausted = False
                    break

                next_offset = source_index + 1
                raw_count += 1
                core_rows.append((source_index, row))

            extension_rows: dict[str, dict[str, list[dict[str, Any]]]] = {}

            if core_rows and bool(
                self.definition.get(
                    "join_extensions",
                    True,
                )
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
                )

            for source_index, core_row in core_rows:
                core_id = normalize_space(
                    core_row.get("_core_id")
                )

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
                }

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

                    rejected_count += 1
                    continue

                if record is None:
                    rejected_count += 1
                    continue

                self._augment_dwca_extra(
                    record,
                    raw_record,
                    core=core,
                    archive_path=archive_path,
                )
                records.append(record)

        self._last_rejected = rejected_count

        return Batch(
            records=records,
            next_cursor=(
                None
                if exhausted
                else json.dumps(
                    {"offset": next_offset},
                    separators=(",", ":"),
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
        configured = self.definition.get("mapping", {})

        if configured is None:
            configured = {}

        if not isinstance(configured, Mapping):
            raise ProviderError(
                "Darwin Core mapping must be an object."
            )

        merged = {
            field: configured.get(field, paths)
            for field, paths in self.DEFAULT_MAPPING.items()
        }

        for field, specification in configured.items():
            if field not in merged:
                merged[str(field)] = specification

        original = self.definition.get("mapping")
        self.definition["mapping"] = merged

        try:
            mapped = super()._map_fields(raw)
        finally:
            if original is None:
                self.definition.pop("mapping", None)
            else:
                self.definition["mapping"] = original

        if _is_empty(mapped.get("canonical_name")):
            mapped["canonical_name"] = mapped.get("scientific_name")

        return mapped

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

        return self._infer_metadata(source)

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
                text = normalize_space(location.text)

                if text:
                    files.append(text)

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
                        field_element.attrib.get(
                            "default"
                        )
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
                    element.attrib.get(
                        "ignoreHeaderLines"
                    ),
                    0,
                ),
            ),
            fields_terminated_by=decode_xml_character(
                element.attrib.get(
                    "fieldsTerminatedBy"
                ),
                "\t",
            ),
            lines_terminated_by=decode_xml_character(
                element.attrib.get(
                    "linesTerminatedBy"
                ),
                "\n",
            ),
            fields_enclosed_by=decode_xml_character(
                element.attrib.get(
                    "fieldsEnclosedBy"
                ),
                '"',
            ),
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
            "core.txt",
            "taxa.txt",
            "taxon.csv",
            "occurrence.csv",
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
            members = source.members()
            core_file = next(
                (
                    member
                    for member in members
                    if Path(member).suffix.casefold()
                    in {".txt", ".tsv", ".csv"}
                ),
                "",
            )

        if not core_file:
            raise ProviderError(
                "Unable to infer Darwin Core core table."
            )

        suffix = Path(core_file).suffix.casefold()
        delimiter = "," if suffix == ".csv" else "\t"
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
                    value
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
                "id",
            },
        )

        return {
            "core": ArchiveTable(
                role="core",
                row_type=normalize_space(
                    self.definition.get("row_type")
                ) or f"{DWC_TERMS}Taxon",
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

    def _iter_table_rows(
        self,
        source: ArchiveSource,
        table: ArchiveTable,
        *,
        start_offset: int,
    ) -> Iterable[tuple[int, dict[str, Any]]]:
        logical_index = 0

        for file_name in table.files:
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
                )

                for _ in range(table.ignore_header_lines):
                    next(reader, None)

                for row in reader:
                    if logical_index < start_offset:
                        logical_index += 1
                        continue

                    normalized = self._row_to_record(
                        row,
                        table,
                    )
                    normalized["_source_file"] = file_name

                    yield logical_index, normalized
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
    ) -> dict[str, dict[str, list[dict[str, Any]]]]:
        result: dict[str, dict[str, list[dict[str, Any]]]] = {}

        for extension in extensions:
            extension_name = (
                local_term_name(extension.row_type)
                or "extension"
            )

            for _, row in self._iter_table_rows(
                source,
                extension,
                start_offset=0,
            ):
                core_id = normalize_space(
                    row.get("_core_id")
                )

                if not core_id or core_id not in core_ids:
                    continue

                result.setdefault(
                    core_id,
                    {},
                ).setdefault(
                    extension_name,
                    [],
                ).append(row)

        return result

    def _augment_dwca_extra(
        self,
        record: Taxon,
        raw_record: Mapping[str, Any],
        *,
        core: ArchiveTable,
        archive_path: Path,
    ) -> None:
        extra = getattr(record, "extra", None)

        if not isinstance(extra, dict):
            return

        extensions = raw_record.get("_extensions", {})

        extra["darwin_core"] = {
            "archive": archive_path.as_posix(),
            "core_file": core.primary_file,
            "core_row_type": core.row_type,
            "core_id": normalize_space(
                raw_record.get("_core_id")
            ),
            "extensions": extensions,
            "terms": {
                key: value
                for key, value in raw_record.items()
                if (
                    isinstance(key, str)
                    and "://" in key
                )
            },
        }

    @staticmethod
    def _column(
        row: list[str],
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
    def _decode_dwca_cursor(
        cursor: str | None,
    ) -> dict[str, int]:
        if not cursor:
            return {"offset": 0}

        try:
            parsed = json.loads(cursor)

            if isinstance(parsed, Mapping):
                offset = int(parsed.get("offset", 0))
            else:
                offset = int(parsed)
        except (json.JSONDecodeError, TypeError, ValueError):
            try:
                offset = int(cursor)
            except (TypeError, ValueError) as error:
                raise ProviderError(
                    f"Invalid Darwin Core cursor: {cursor!r}."
                ) from error

        if offset < 0:
            raise ProviderError(
                "Darwin Core cursor must be non-negative."
            )

        return {"offset": offset}
