#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/authority.py

Taxonomic authorship and nomenclatural authority normalization.

This module owns:

- scientific-name authorship normalization,
- author abbreviation normalization,
- authority alias handling,
- authorship year extraction,
- basionym-parentheses detection,
- author-list parsing,
- normalized authority keys,
- authorship comparison,
- authorship similarity scoring,
- authority validation,
- authority metadata serialization,
- compatibility helpers for providers and reconciliation.

Taxonomic names often differ only in punctuation, spacing, author
abbreviations, diacritics, parentheses, conjunctions, and publication year
format. This module provides one shared normalization policy so all providers
and reconciliation code compare authorship consistently.

Copyright (c) 2026 ZZX-Laboratories

Licensed under the MIT License.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence


AUTHORITY_SCHEMA_VERSION = 1

UNKNOWN_AUTHORITY = ""

__all__ = [
    "AUTHORITY_SCHEMA_VERSION",
    "UNKNOWN_AUTHORITY",
    "AuthorityError",
    "AuthorityAuthor",
    "ParsedAuthority",
    "AuthorityComparison",
    "AuthorityValidation",
    "AuthorityRegistry",
    "DEFAULT_AUTHORITY_ALIASES",
    "DEFAULT_REGISTRY",
    "normalize_space",
    "strip_diacritics",
    "authority_key",
    "extract_year",
    "has_basionym_parentheses",
    "normalize_author_name",
    "normalize_authority",
    "parse_authority",
    "compare_authorities",
    "authority_similarity",
    "authorities_equivalent",
    "validate_authority",
    "authority_metadata",
    "normalize_authority_list",
    "split_name_and_authority",
    "iter_normalized_authorities",
    "authority_fingerprint",
    "authority_registry_from_sources",
    "serialize_authority",
    "deserialize_authority",
    "compare_authority_sets",
]

YEAR_PATTERN = re.compile(
    r"""
    (?<!\d)
    (?P<year>
        1[5-9]\d{2}
        |
        20\d{2}
        |
        21\d{2}
    )
    (?P<suffix>[a-z]?)
    (?!\d)
    """,
    re.IGNORECASE | re.VERBOSE,
)

OUTER_PARENTHESES_PATTERN = re.compile(
    r"^\s*\((?P<inner>.*)\)\s*$"
)

LEADING_PARENTHESES_PATTERN = re.compile(
    r"^\s*\((?P<inner>[^()]*)\)\s*(?P<remainder>.*)$"
)

YEAR_ONLY_PATTERN = re.compile(
    r"^(?P<year>1[5-9]\d{2}|20\d{2}|21\d{2})(?P<suffix>[a-z]?)$",
    re.IGNORECASE,
)

MULTISPACE_PATTERN = re.compile(
    r"\s+"
)

COMMA_SPACE_PATTERN = re.compile(
    r"\s*,\s*"
)

SEMICOLON_SPACE_PATTERN = re.compile(
    r"\s*;\s*"
)

AMPERSAND_SPACE_PATTERN = re.compile(
    r"\s*&\s*"
)

COLON_SPACE_PATTERN = re.compile(
    r"\s*:\s*"
)

PERIOD_SPACE_PATTERN = re.compile(
    r"\.\s+"
)

AUTHOR_SEPARATOR_PATTERN = re.compile(
    r"""
    \s*
    (?:
        &
        |
        ;
        |
        \band\b
        |
        \bet\b
    )
    \s*
    """,
    re.IGNORECASE | re.VERBOSE,
)

TRAILING_YEAR_PATTERN = re.compile(
    r"""
    ^(?P<body>.*?)
    (?:
        \s*,
        \s*
        |
        \s+
    )
    (?P<year>
        1[5-9]\d{2}
        |
        20\d{2}
        |
        21\d{2}
    )
    (?P<suffix>[a-z]?)
    \s*$
    """,
    re.IGNORECASE | re.VERBOSE,
)

EX_AUTHOR_PATTERN = re.compile(
    r"\s+\bex\b\s+",
    re.IGNORECASE,
)

IN_AUTHOR_PATTERN = re.compile(
    r"\s+\bin\b\s+",
    re.IGNORECASE,
)

AUTHOR_PARTICLE_PATTERN = re.compile(
    r"""
    ^(?:
        de
        |
        del
        |
        della
        |
        der
        |
        van
        |
        von
        |
        da
        |
        dos
        |
        do
        |
        di
        |
        du
        |
        le
        |
        la
        |
        el
    )$
    """,
    re.IGNORECASE | re.VERBOSE,
)

DEFAULT_AUTHORITY_ALIASES: dict[str, str] = {
    "l": "L.",
    "linnaeus": "L.",
    "linn": "L.",
    "linn.": "L.",
    "l.": "L.",
    "mill": "Mill.",
    "miller": "Mill.",
    "mill.": "Mill.",
    "dc": "DC.",
    "dc.": "DC.",
    "de candolle": "DC.",
    "a dc": "A.DC.",
    "a.dc": "A.DC.",
    "a.dc.": "A.DC.",
    "de wild": "De Wild.",
    "de wild.": "De Wild.",
    "lam": "Lam.",
    "lam.": "Lam.",
    "lamarck": "Lam.",
    "hook": "Hook.",
    "hook.": "Hook.",
    "hooker": "Hook.",
    "hook f": "Hook.f.",
    "hook.f": "Hook.f.",
    "hook.f.": "Hook.f.",
    "benth": "Benth.",
    "benth.": "Benth.",
    "bentham": "Benth.",
    "f muell": "F.Muell.",
    "f.muell": "F.Muell.",
    "f.muell.": "F.Muell.",
    "muell arg": "Müll.Arg.",
    "müll arg": "Müll.Arg.",
    "muell.arg": "Müll.Arg.",
    "müll.arg": "Müll.Arg.",
    "müll.arg.": "Müll.Arg.",
    "r br": "R.Br.",
    "r.br": "R.Br.",
    "r.br.": "R.Br.",
    "robert brown": "R.Br.",
    "willd": "Willd.",
    "willd.": "Willd.",
    "willdenow": "Willd.",
    "schltr": "Schltr.",
    "schltr.": "Schltr.",
    "schlechter": "Schltr.",
    "p beauv": "P.Beauv.",
    "p.beauv": "P.Beauv.",
    "p.beauv.": "P.Beauv.",
    "gaertn": "Gaertn.",
    "gaertn.": "Gaertn.",
    "gärtner": "Gaertn.",
    "juss": "Juss.",
    "juss.": "Juss.",
    "a juss": "A.Juss.",
    "a.juss": "A.Juss.",
    "a.juss.": "A.Juss.",
    "pers": "Pers.",
    "pers.": "Pers.",
    "persoon": "Pers.",
    "fr": "Fr.",
    "fr.": "Fr.",
    "fries": "Fr.",
    "sacc": "Sacc.",
    "sacc.": "Sacc.",
    "saccardo": "Sacc.",
    "bull": "Bull.",
    "bull.": "Bull.",
    "bulliard": "Bull.",
    "scop": "Scop.",
    "scop.": "Scop.",
    "scopoli": "Scop.",
    "fab": "F.",
    "fabr": "Fabr.",
    "fabr.": "Fabr.",
    "fabricius": "Fabr.",
    "cuv": "Cuvier",
    "cuvier": "Cuvier",
    "pallas": "Pallas",
    "pall": "Pall.",
    "pall.": "Pall.",
    "gray": "Gray",
    "gmel": "Gmelin",
    "gmelin": "Gmelin",
    "temminck": "Temminck",
    "bonaparte": "Bonaparte",
    "boulenger": "Boulenger",
    "walbaum": "Walbaum",
    "bloch": "Bloch",
    "lacepede": "Lacépède",
    "lacépède": "Lacépède",
    "smith": "Smith",
    "j e smith": "J.E.Sm.",
    "j.e.smith": "J.E.Sm.",
    "j.e.sm.": "J.E.Sm.",
}

CONJUNCTION_ALIASES = {
    "and": "&",
    "et": "&",
    "&": "&",
}

BASIONYM_KEYWORDS = {
    "basionym",
    "original combination",
    "new combination",
    "recombined",
}


class AuthorityError(ValueError):
    """Raised when authority data cannot be normalized safely."""


@dataclass(slots=True, frozen=True)
class AuthorityAuthor:
    """One normalized nomenclatural author."""

    display_name: str
    comparison_key: str
    role: str = "author"
    position: int = 0
    raw: str = ""

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible author object."""

        return {
            "display_name": self.display_name,
            "comparison_key": self.comparison_key,
            "role": self.role,
            "position": self.position,
            "raw": self.raw,
        }


@dataclass(slots=True)
class ParsedAuthority:
    """Structured representation of a taxonomic authority string."""

    raw: str
    normalized: str
    authors: list[AuthorityAuthor]
    ex_authors: list[AuthorityAuthor]
    in_authors: list[AuthorityAuthor]
    year: int | None
    year_suffix: str
    basionym_parentheses: bool
    basionym_authors: list[AuthorityAuthor] = field(
        default_factory=list
    )
    ambiguous: bool = False
    warnings: list[str] = field(
        default_factory=list
    )

    @property
    def author_key(self) -> str:
        """Return a deterministic author-only comparison key."""

        parts: list[str] = []

        if self.basionym_authors:
            parts.append(
                "basionym:"
                + "&".join(
                    author.comparison_key
                    for author in self.basionym_authors
                )
            )

        if self.ex_authors:
            parts.append(
                "ex:"
                + "&".join(
                    author.comparison_key
                    for author in self.ex_authors
                )
            )

        if self.authors:
            parts.append(
                "authors:"
                + "&".join(
                    author.comparison_key
                    for author in self.authors
                )
            )

        if self.in_authors:
            parts.append(
                "in:"
                + "&".join(
                    author.comparison_key
                    for author in self.in_authors
                )
            )

        return "|".join(parts)

    @property
    def full_key(self) -> str:
        """Return a deterministic full authorship key."""

        year_value = (
            f"{self.year}{self.year_suffix}"
            if self.year is not None
            else ""
        )

        return "|".join(
            (
                self.author_key,
                year_value,
                "basionym"
                if self.basionym_parentheses
                else "direct",
            )
        )

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible parsed authority."""

        return {
            "schema_version": (
                AUTHORITY_SCHEMA_VERSION
            ),
            "raw": self.raw,
            "normalized": self.normalized,
            "basionym_authors": [
                author.to_dict()
                for author in self.basionym_authors
            ],
            "authors": [
                author.to_dict()
                for author in self.authors
            ],
            "ex_authors": [
                author.to_dict()
                for author in self.ex_authors
            ],
            "in_authors": [
                author.to_dict()
                for author in self.in_authors
            ],
            "year": self.year,
            "year_suffix": self.year_suffix,
            "basionym_parentheses": (
                self.basionym_parentheses
            ),
            "ambiguous": self.ambiguous,
            "warnings": list(
                self.warnings
            ),
            "author_key": self.author_key,
            "full_key": self.full_key,
        }


@dataclass(slots=True)
class AuthorityComparison:
    """Comparison result for two authorship strings."""

    left: ParsedAuthority
    right: ParsedAuthority
    author_score: float
    year_score: float
    parentheses_score: float
    total_score: float
    exact: bool
    equivalent: bool
    warnings: list[str] = field(
        default_factory=list
    )

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible comparison."""

        return {
            "left": self.left.to_dict(),
            "right": self.right.to_dict(),
            "author_score": round(
                self.author_score,
                6,
            ),
            "year_score": round(
                self.year_score,
                6,
            ),
            "parentheses_score": round(
                self.parentheses_score,
                6,
            ),
            "total_score": round(
                self.total_score,
                6,
            ),
            "exact": self.exact,
            "equivalent": self.equivalent,
            "warnings": list(
                self.warnings
            ),
        }


@dataclass(slots=True)
class AuthorityValidation:
    """Validation result for one authorship string."""

    valid: bool
    errors: list[str] = field(
        default_factory=list
    )
    warnings: list[str] = field(
        default_factory=list
    )
    parsed: ParsedAuthority | None = None

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible validation result."""

        return {
            "valid": self.valid,
            "errors": list(
                self.errors
            ),
            "warnings": list(
                self.warnings
            ),
            "parsed": (
                self.parsed.to_dict()
                if self.parsed is not None
                else None
            ),
        }


def normalize_space(value: Any) -> str:
    """Normalize Unicode and collapse repeated whitespace."""

    text = unicodedata.normalize(
        "NFKC",
        str(
            value
            if value is not None
            else ""
        ),
    )

    return MULTISPACE_PATTERN.sub(
        " ",
        text,
    ).strip()


def strip_diacritics(value: Any) -> str:
    """Return a comparison form with combining marks removed."""

    text = unicodedata.normalize(
        "NFKD",
        normalize_space(value),
    )

    return "".join(
        character
        for character in text
        if not unicodedata.combining(
            character
        )
    )


def authority_key(value: Any) -> str:
    """Return a loose deterministic authorship comparison key."""

    text = strip_diacritics(
        value
    ).casefold()

    text = re.sub(
        r"[^a-z0-9]+",
        "",
        text,
    )

    return text


class AuthorityRegistry:
    """
    Author abbreviation alias registry.

    The registry may be initialized from built-in aliases, a JSON mapping, or
    both. Keys are normalized comparison forms; values are preferred display
    abbreviations.
    """

    def __init__(
        self,
        aliases: Mapping[str, str] | None = None,
    ) -> None:
        self.aliases: dict[str, str] = {}

        for source, target in (
            DEFAULT_AUTHORITY_ALIASES.items()
        ):
            self.register(
                source,
                target,
            )

        if aliases:
            for source, target in aliases.items():
                self.register(
                    source,
                    target,
                )

    @classmethod
    def from_json(
        cls,
        path: Path,
    ) -> AuthorityRegistry:
        """Load an alias registry from a JSON object."""

        source_path = Path(path)

        try:
            value = json.loads(
                source_path.read_text(
                    encoding="utf-8",
                )
            )
        except OSError as error:
            raise AuthorityError(
                f"Unable to read authority aliases "
                f"{source_path}: {error}"
            ) from error
        except json.JSONDecodeError as error:
            raise AuthorityError(
                f"Invalid authority alias JSON in "
                f"{source_path}: {error}"
            ) from error

        if not isinstance(value, Mapping):
            raise AuthorityError(
                "Authority alias file must contain "
                "a JSON object."
            )

        return cls(
            {
                str(key): str(item)
                for key, item in value.items()
            }
        )

    def register(
        self,
        alias: Any,
        preferred: Any,
    ) -> None:
        """Register one authority alias."""

        alias_text = normalize_space(
            alias
        )

        preferred_text = normalize_space(
            preferred
        )

        if not alias_text:
            raise AuthorityError(
                "Authority alias cannot be empty."
            )

        if not preferred_text:
            raise AuthorityError(
                "Preferred authority cannot be empty."
            )

        self.aliases[
            authority_key(alias_text)
        ] = preferred_text

        self.aliases[
            authority_key(preferred_text)
        ] = preferred_text

    def preferred(
        self,
        value: Any,
    ) -> str:
        """Return the preferred display form for one author."""

        text = normalize_space(
            value
        )

        if not text:
            return ""

        return self.aliases.get(
            authority_key(text),
            self._format_unknown_author(
                text
            ),
        )

    def comparison_key(
        self,
        value: Any,
    ) -> str:
        """Return the normalized key for one author."""

        preferred = self.preferred(
            value
        )

        return authority_key(
            preferred
        )

    def to_dict(self) -> dict[str, str]:
        """Return aliases in deterministic order."""

        return dict(
            sorted(
                self.aliases.items()
            )
        )

    def __contains__(self, value: object) -> bool:
        """Return whether an alias or preferred form is registered."""

        return authority_key(value) in self.aliases

    def __len__(self) -> int:
        """Return the number of normalized alias keys."""

        return len(self.aliases)

    def copy(self) -> "AuthorityRegistry":
        """Return an independent registry containing the same aliases."""

        registry = AuthorityRegistry({})
        registry.aliases = dict(self.aliases)
        return registry

    def merge(
        self,
        aliases: Mapping[str, str] | "AuthorityRegistry",
        *,
        overwrite: bool = True,
    ) -> None:
        """Merge aliases into this registry."""

        source = (
            aliases.aliases
            if isinstance(aliases, AuthorityRegistry)
            else aliases
        )

        for alias, preferred in source.items():
            key = authority_key(alias)

            if not overwrite and key in self.aliases:
                continue

            self.register(alias, preferred)

    def unregister(self, alias: Any) -> bool:
        """Remove one normalized alias key and report whether it existed."""

        key = authority_key(alias)

        if not key:
            return False

        return self.aliases.pop(key, None) is not None

    def to_json(
        self,
        path: Path,
        *,
        indent: int = 2,
    ) -> None:
        """Atomically serialize the registry as UTF-8 JSON."""

        destination = Path(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(
            self.to_dict(),
            ensure_ascii=False,
            indent=indent,
            sort_keys=True,
        ) + "\n"
        temporary = destination.with_name(
            f".{destination.name}.tmp"
        )
        temporary.write_text(payload, encoding="utf-8")
        temporary.replace(destination)

    @staticmethod
    def _format_unknown_author(
        value: str,
    ) -> str:
        """Apply conservative punctuation normalization to an unknown author."""

        text = normalize_space(
            value
        )

        text = COMMA_SPACE_PATTERN.sub(
            ", ",
            text,
        )

        text = PERIOD_SPACE_PATTERN.sub(
            ".",
            text,
        )

        text = re.sub(
            r"\s*\.\s*",
            ".",
            text,
        )

        text = re.sub(
            r"\.{2,}",
            ".",
            text,
        )

        return normalize_space(
            text
        )


DEFAULT_REGISTRY = AuthorityRegistry()


def extract_year(
    value: Any,
) -> tuple[int | None, str]:
    """Extract the last plausible nomenclatural year and optional suffix."""

    text = normalize_space(
        value
    )

    matches = list(
        YEAR_PATTERN.finditer(
            text
        )
    )

    if not matches:
        return (
            None,
            "",
        )

    match = matches[-1]

    return (
        int(
            match.group("year")
        ),
        (
            match.group(
                "suffix"
            )
            or ""
        ).casefold(),
    )


def has_basionym_parentheses(
    value: Any,
) -> bool:
    """Return whether the primary authority is enclosed in parentheses."""

    text = normalize_space(
        value
    )

    if not text:
        return False

    text_without_year = (
        TRAILING_YEAR_PATTERN.sub(
            lambda match: normalize_space(
                match.group("body")
            ),
            text,
        )
    )

    if OUTER_PARENTHESES_PATTERN.fullmatch(text_without_year):
        return True

    leading = LEADING_PARENTHESES_PATTERN.fullmatch(
        text_without_year
    )

    return bool(
        leading
        and normalize_space(leading.group("inner"))
    )


def normalize_author_name(
    value: Any,
    *,
    registry: AuthorityRegistry | None = None,
) -> str:
    """Normalize one author name or abbreviation."""

    active_registry = (
        registry
        if registry is not None
        else DEFAULT_REGISTRY
    )

    return active_registry.preferred(
        value
    )


def normalize_authority(
    value: Any,
    *,
    registry: AuthorityRegistry | None = None,
    include_year: bool = True,
    preserve_parentheses: bool = True,
) -> str:
    """Normalize a complete taxonomic authorship string."""

    parsed = parse_authority(
        value,
        registry=registry,
    )

    if not parsed.normalized:
        return ""

    result = _render_parsed_authority(
        parsed,
        include_year=include_year,
        preserve_parentheses=(
            preserve_parentheses
        ),
    )

    return result


def parse_authority(
    value: Any,
    *,
    registry: AuthorityRegistry | None = None,
) -> ParsedAuthority:
    """Parse a taxonomic authorship string into structured components."""

    active_registry = (
        registry
        if registry is not None
        else DEFAULT_REGISTRY
    )

    raw = normalize_space(
        value
    )

    if not raw:
        return ParsedAuthority(
            raw="",
            normalized="",
            authors=[],
            ex_authors=[],
            in_authors=[],
            year=None,
            year_suffix="",
            basionym_parentheses=False,
            basionym_authors=[],
        )

    warnings: list[str] = []

    year, year_suffix = extract_year(
        raw
    )

    body = raw

    trailing_match = (
        TRAILING_YEAR_PATTERN.fullmatch(
            body
        )
    )

    if trailing_match:
        body = normalize_space(
            trailing_match.group(
                "body"
            )
        )

    basionym_parentheses = False
    basionym_part = ""

    parentheses_match = (
        OUTER_PARENTHESES_PATTERN.fullmatch(
            body
        )
    )

    if parentheses_match:
        basionym_parentheses = True
        body = normalize_space(
            parentheses_match.group(
                "inner"
            )
        )
    else:
        leading_match = LEADING_PARENTHESES_PATTERN.fullmatch(
            body
        )

        if leading_match:
            basionym_part = normalize_space(
                leading_match.group("inner")
            )
            body = normalize_space(
                leading_match.group("remainder")
            )
            basionym_parentheses = bool(basionym_part)

    ex_part = ""
    in_part = ""
    primary_part = body

    ex_split = EX_AUTHOR_PATTERN.split(
        primary_part,
        maxsplit=1,
    )

    if len(ex_split) == 2:
        ex_part = normalize_space(
            ex_split[0]
        )
        primary_part = normalize_space(
            ex_split[1]
        )

    in_split = IN_AUTHOR_PATTERN.split(
        primary_part,
        maxsplit=1,
    )

    if len(in_split) == 2:
        primary_part = normalize_space(
            in_split[0]
        )
        in_part = normalize_space(
            in_split[1]
        )

    basionym_authors = _parse_author_list(
        basionym_part,
        role="basionym_author",
        registry=active_registry,
    )

    ex_authors = _parse_author_list(
        ex_part,
        role="ex_author",
        registry=active_registry,
    )

    authors = _parse_author_list(
        primary_part,
        role="author",
        registry=active_registry,
    )

    in_authors = _parse_author_list(
        in_part,
        role="in_author",
        registry=active_registry,
    )

    if not authors and primary_part:
        warnings.append(
            "No authors could be parsed from the "
            "primary authority segment."
        )

    ambiguous = False

    if (
        "," in primary_part
        and "&" not in primary_part
        and " and " not in primary_part.casefold()
    ):
        comma_parts = [
            part
            for part in COMMA_SPACE_PATTERN.split(
                primary_part
            )
            if normalize_space(part)
        ]

        if len(comma_parts) > 2:
            ambiguous = True
            warnings.append(
                "Authority contains multiple commas "
                "with ambiguous author separation."
            )

    provisional = ParsedAuthority(
        raw=raw,
        normalized="",
        authors=authors,
        ex_authors=ex_authors,
        in_authors=in_authors,
        year=year,
        year_suffix=year_suffix,
        basionym_parentheses=(
            basionym_parentheses
        ),
        basionym_authors=basionym_authors,
        ambiguous=ambiguous,
        warnings=warnings,
    )

    normalized = _render_parsed_authority(
        provisional,
        include_year=True,
        preserve_parentheses=True,
    )

    provisional.normalized = normalized

    return provisional


def compare_authorities(
    left: Any,
    right: Any,
    *,
    registry: AuthorityRegistry | None = None,
    equivalent_threshold: float = 0.85,
) -> AuthorityComparison:
    """Compare two authorship strings using normalized components."""

    if not 0.0 <= equivalent_threshold <= 1.0:
        raise AuthorityError(
            "equivalent_threshold must be between 0.0 and 1.0."
        )

    left_parsed = parse_authority(
        left,
        registry=registry,
    )

    right_parsed = parse_authority(
        right,
        registry=registry,
    )

    warnings: list[str] = []

    if (
        not left_parsed.normalized
        and not right_parsed.normalized
    ):
        return AuthorityComparison(
            left=left_parsed,
            right=right_parsed,
            author_score=1.0,
            year_score=1.0,
            parentheses_score=1.0,
            total_score=1.0,
            exact=True,
            equivalent=True,
            warnings=warnings,
        )

    if (
        not left_parsed.normalized
        or not right_parsed.normalized
    ):
        return AuthorityComparison(
            left=left_parsed,
            right=right_parsed,
            author_score=0.0,
            year_score=0.0,
            parentheses_score=0.0,
            total_score=0.0,
            exact=False,
            equivalent=False,
            warnings=warnings,
        )

    author_score = _author_sequence_similarity(
        left_parsed,
        right_parsed,
    )

    year_score = _year_similarity(
        left_parsed,
        right_parsed,
    )

    parentheses_score = (
        1.0
        if (
            left_parsed.basionym_parentheses
            == right_parsed.basionym_parentheses
        )
        else 0.5
    )

    total_score = (
        author_score * 0.70
        + year_score * 0.20
        + parentheses_score * 0.10
    )

    exact = (
        left_parsed.full_key
        == right_parsed.full_key
    )

    equivalent = (
        exact
        or total_score
        >= equivalent_threshold
    )

    if (
        left_parsed.year is not None
        and right_parsed.year is not None
        and left_parsed.year
        != right_parsed.year
    ):
        warnings.append(
            "Authority years differ."
        )

    if (
        left_parsed.basionym_parentheses
        != right_parsed.basionym_parentheses
    ):
        warnings.append(
            "Basionym-parentheses usage differs."
        )

    return AuthorityComparison(
        left=left_parsed,
        right=right_parsed,
        author_score=author_score,
        year_score=year_score,
        parentheses_score=(
            parentheses_score
        ),
        total_score=max(
            0.0,
            min(
                1.0,
                total_score,
            ),
        ),
        exact=exact,
        equivalent=equivalent,
        warnings=warnings,
    )


def authority_similarity(
    left: Any,
    right: Any,
    *,
    registry: AuthorityRegistry | None = None,
) -> float:
    """Return normalized authority similarity from 0.0 to 1.0."""

    return compare_authorities(
        left,
        right,
        registry=registry,
    ).total_score


def authorities_equivalent(
    left: Any,
    right: Any,
    *,
    registry: AuthorityRegistry | None = None,
    threshold: float = 0.85,
) -> bool:
    """Return whether two authority strings are equivalent."""

    return compare_authorities(
        left,
        right,
        registry=registry,
        equivalent_threshold=threshold,
    ).equivalent


def validate_authority(
    value: Any,
    *,
    registry: AuthorityRegistry | None = None,
    require_author: bool = False,
    require_year: bool = False,
) -> AuthorityValidation:
    """Validate one taxonomic authorship string."""

    errors: list[str] = []
    warnings: list[str] = []

    parsed = parse_authority(
        value,
        registry=registry,
    )

    if not parsed.normalized:
        if require_author:
            errors.append(
                "Authority is required."
            )

        return AuthorityValidation(
            valid=not errors,
            errors=errors,
            warnings=warnings,
            parsed=parsed,
        )

    if require_author and not parsed.authors:
        errors.append(
            "Authority contains no primary author."
        )

    if require_year and parsed.year is None:
        errors.append(
            "Authority contains no publication year."
        )

    if (
        parsed.year is not None
        and (
            parsed.year < 1500
            or parsed.year > 2100
        )
    ):
        warnings.append(
            "Authority year is outside the expected "
            "nomenclatural range."
        )

    if parsed.ambiguous:
        warnings.append(
            "Authority parsing is ambiguous."
        )

    warnings.extend(
        parsed.warnings
    )

    duplicate_keys = _duplicate_author_keys(
        [
            *parsed.basionym_authors,
            *parsed.ex_authors,
            *parsed.authors,
            *parsed.in_authors,
        ]
    )

    if duplicate_keys:
        warnings.append(
            "Authority contains duplicate normalized "
            "authors: "
            + ", ".join(
                duplicate_keys
            )
        )

    return AuthorityValidation(
        valid=not errors,
        errors=errors,
        warnings=warnings,
        parsed=parsed,
    )


def authority_metadata(
    value: Any,
    *,
    registry: AuthorityRegistry | None = None,
) -> dict[str, Any]:
    """Return normalized authorship metadata for archive storage."""

    return parse_authority(
        value,
        registry=registry,
    ).to_dict()


def normalize_authority_list(
    values: Iterable[Any],
    *,
    registry: AuthorityRegistry | None = None,
) -> list[str]:
    """Normalize and deduplicate multiple authority strings."""

    result: list[str] = []
    seen: set[str] = set()

    for value in values:
        normalized = normalize_authority(
            value,
            registry=registry,
        )

        if not normalized:
            continue

        key = parse_authority(
            normalized,
            registry=registry,
        ).full_key

        if key in seen:
            continue

        seen.add(key)
        result.append(normalized)

    return result


def split_name_and_authority(
    scientific_name: Any,
    *,
    registry: AuthorityRegistry | None = None,
) -> tuple[str, str]:
    """
    Split a scientific name from a probable trailing authority.

    This is conservative and returns the original string unchanged when the
    trailing segment cannot be interpreted as an authority.
    """

    text = normalize_space(
        scientific_name
    )

    if not text:
        return (
            "",
            "",
        )

    tokens = text.split()

    if len(tokens) < 3:
        return (
            text,
            "",
        )

    candidate_starts: list[int] = []

    for index in range(
        2,
        len(tokens),
    ):
        token = tokens[index]

        if (
            token.startswith("(")
            or token[:1].isupper()
            or YEAR_PATTERN.search(token)
        ):
            candidate_starts.append(
                index
            )

    for start in candidate_starts:
        name_part = normalize_space(
            " ".join(
                tokens[:start]
            )
        )

        authority_part = normalize_space(
            " ".join(
                tokens[start:]
            )
        )

        parsed = parse_authority(
            authority_part,
            registry=registry,
        )

        if parsed.authors:
            return (
                name_part,
                parsed.normalized,
            )

    return (
        text,
        "",
    )


def _parse_author_list(
    value: str,
    *,
    role: str,
    registry: AuthorityRegistry,
) -> list[AuthorityAuthor]:
    """Parse a list of authors from one authority segment."""

    text = normalize_space(
        value
    )

    if not text:
        return []

    text = SEMICOLON_SPACE_PATTERN.sub(
        " & ",
        text,
    )

    text = re.sub(
        r"\s+\band\b\s+",
        " & ",
        text,
        flags=re.IGNORECASE,
    )

    parts = [
        normalize_space(part)
        for part in AUTHOR_SEPARATOR_PATTERN.split(
            text
        )
        if normalize_space(part)
    ]

    if len(parts) == 1:
        parts = _split_comma_author_list(
            parts[0]
        )

    authors: list[AuthorityAuthor] = []

    for position, raw_author in enumerate(
        parts
    ):
        preferred = registry.preferred(
            raw_author
        )

        if not preferred:
            continue

        authors.append(
            AuthorityAuthor(
                display_name=preferred,
                comparison_key=(
                    registry.comparison_key(
                        preferred
                    )
                ),
                role=role,
                position=position,
                raw=raw_author,
            )
        )

    return authors


def _split_comma_author_list(
    value: str,
) -> list[str]:
    """
    Split comma-separated authors conservatively.

    A two-part value is retained as one author because it may be a surname and
    initials in inverted form. Three or more simple parts are treated as an
    author list.
    """

    parts = [
        normalize_space(part)
        for part in COMMA_SPACE_PATTERN.split(
            value
        )
        if normalize_space(part)
    ]

    if len(parts) <= 2:
        return [
            normalize_space(value)
        ]

    if any(
        YEAR_PATTERN.fullmatch(part)
        for part in parts
    ):
        return [
            normalize_space(value)
        ]

    return parts


def _render_parsed_authority(
    parsed: ParsedAuthority,
    *,
    include_year: bool,
    preserve_parentheses: bool,
) -> str:
    """Render a parsed authority in canonical display form."""

    segments: list[str] = []

    basionym = " & ".join(
        author.display_name
        for author in parsed.basionym_authors
    )

    primary = " & ".join(
        author.display_name
        for author in parsed.authors
    )

    ex_segment = " & ".join(
        author.display_name
        for author in parsed.ex_authors
    )

    in_segment = " & ".join(
        author.display_name
        for author in parsed.in_authors
    )

    if basionym:
        rendered_basionym = (
            f"({basionym})"
            if preserve_parentheses
            else basionym
        )
        segments.append(rendered_basionym)

    if ex_segment:
        segments.append(
            ex_segment
        )
        segments.append(
            "ex"
        )

    if primary:
        rendered_primary = primary

        if (
            preserve_parentheses
            and parsed.basionym_parentheses
            and not parsed.basionym_authors
        ):
            rendered_primary = (
                f"({rendered_primary})"
            )

        segments.append(
            rendered_primary
        )

    if in_segment:
        segments.append(
            "in"
        )
        segments.append(
            in_segment
        )

    result = " ".join(
        segments
    )

    if (
        include_year
        and parsed.year is not None
    ):
        year_text = (
            f"{parsed.year}"
            f"{parsed.year_suffix}"
        )

        result = (
            f"{result}, {year_text}"
            if result
            else year_text
        )

    return normalize_space(
        result
    )


def _author_sequence_similarity(
    left: ParsedAuthority,
    right: ParsedAuthority,
) -> float:
    """Compare author sequences across primary, ex, and in roles."""

    left_groups = (
        left.basionym_authors,
        left.ex_authors,
        left.authors,
        left.in_authors,
    )

    right_groups = (
        right.basionym_authors,
        right.ex_authors,
        right.authors,
        right.in_authors,
    )

    weights = (
        0.20,
        0.10,
        0.60,
        0.10,
    )

    score = 0.0
    total_weight = 0.0

    for (
        left_group,
        right_group,
        weight,
    ) in zip(
        left_groups,
        right_groups,
        weights,
    ):
        if not left_group and not right_group:
            continue

        total_weight += weight

        left_keys = [
            author.comparison_key
            for author in left_group
        ]

        right_keys = [
            author.comparison_key
            for author in right_group
        ]

        score += (
            _sequence_similarity(
                left_keys,
                right_keys,
            )
            * weight
        )

    if total_weight <= 0:
        return 0.0

    return max(
        0.0,
        min(
            1.0,
            score / total_weight,
        ),
    )


def _sequence_similarity(
    left: Sequence[str],
    right: Sequence[str],
) -> float:
    """Return order-aware similarity for two normalized author lists."""

    if not left and not right:
        return 1.0

    if not left or not right:
        return 0.0

    if list(left) == list(right):
        return 1.0

    left_set = set(left)
    right_set = set(right)

    union = left_set | right_set

    if not union:
        return 0.0

    jaccard = (
        len(
            left_set & right_set
        )
        / len(union)
    )

    positional_matches = sum(
        1
        for left_value, right_value
        in zip(left, right)
        if left_value == right_value
    )

    positional = (
        positional_matches
        / max(
            len(left),
            len(right),
        )
    )

    return (
        jaccard * 0.70
        + positional * 0.30
    )


def _year_similarity(
    left: ParsedAuthority,
    right: ParsedAuthority,
) -> float:
    """Compare nomenclatural years."""

    if (
        left.year is None
        and right.year is None
    ):
        return 1.0

    if (
        left.year is None
        or right.year is None
    ):
        return 0.5

    if (
        left.year == right.year
        and left.year_suffix
        == right.year_suffix
    ):
        return 1.0

    if left.year == right.year:
        return 0.9

    difference = abs(
        left.year - right.year
    )

    if difference == 1:
        return 0.4

    if difference <= 5:
        return 0.2

    return 0.0


def _duplicate_author_keys(
    authors: Sequence[AuthorityAuthor],
) -> list[str]:
    """Return duplicate author comparison keys."""

    seen: set[str] = set()
    duplicates: set[str] = set()

    for author in authors:
        key = author.comparison_key

        if key in seen:
            duplicates.add(key)

        seen.add(key)

    return sorted(
        duplicates
    )

def iter_normalized_authorities(
    values: Iterable[Any],
    *,
    registry: AuthorityRegistry | None = None,
    include_empty: bool = False,
) -> Iterator[str]:
    """Yield normalized authorities lazily in input order."""

    for value in values:
        normalized = normalize_authority(value, registry=registry)

        if normalized or include_empty:
            yield normalized


def authority_fingerprint(
    value: Any,
    *,
    registry: AuthorityRegistry | None = None,
    include_year: bool = True,
    include_parentheses: bool = True,
) -> str:
    """Return a stable reconciliation fingerprint for an authority."""

    parsed = parse_authority(value, registry=registry)

    if not parsed.normalized:
        return ""

    parts = [parsed.author_key]

    if include_year:
        parts.append(
            f"{parsed.year or ''}{parsed.year_suffix}"
        )

    if include_parentheses:
        parts.append(
            "basionym"
            if parsed.basionym_parentheses
            else "direct"
        )

    return "|".join(parts)


def authority_registry_from_sources(
    *sources: Mapping[str, str] | AuthorityRegistry | Path,
) -> AuthorityRegistry:
    """Build one registry from mappings, registries, and JSON files."""

    registry = AuthorityRegistry()

    for source in sources:
        if isinstance(source, AuthorityRegistry):
            registry.merge(source)
        elif isinstance(source, Path):
            registry.merge(AuthorityRegistry.from_json(source))
        elif isinstance(source, Mapping):
            registry.merge(source)
        else:
            raise AuthorityError(
                "Authority registry sources must be mappings, "
                "AuthorityRegistry instances, or pathlib.Path objects."
            )

    return registry


def serialize_authority(
    value: Any,
    *,
    registry: AuthorityRegistry | None = None,
    indent: int | None = None,
) -> str:
    """Serialize one parsed authority as deterministic JSON."""

    return json.dumps(
        authority_metadata(value, registry=registry),
        ensure_ascii=False,
        sort_keys=True,
        indent=indent,
        separators=(None if indent is not None else (",", ":")),
    )


def deserialize_authority(
    value: str | bytes | bytearray | Mapping[str, Any],
    *,
    registry: AuthorityRegistry | None = None,
) -> ParsedAuthority:
    """Deserialize authority metadata and normalize it through the parser."""

    if isinstance(value, Mapping):
        payload = dict(value)
    else:
        try:
            payload = json.loads(value)
        except (TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise AuthorityError(
                f"Invalid serialized authority metadata: {error}"
            ) from error

    if not isinstance(payload, Mapping):
        raise AuthorityError(
            "Serialized authority metadata must contain a JSON object."
        )

    candidate = (
        payload.get("raw")
        or payload.get("normalized")
        or ""
    )

    return parse_authority(candidate, registry=registry)


def compare_authority_sets(
    left: Iterable[Any],
    right: Iterable[Any],
    *,
    registry: AuthorityRegistry | None = None,
    equivalent_threshold: float = 0.85,
) -> dict[str, Any]:
    """Compare two authority collections with deterministic best matching."""

    if not 0.0 <= equivalent_threshold <= 1.0:
        raise AuthorityError(
            "equivalent_threshold must be between 0.0 and 1.0."
        )

    left_values = normalize_authority_list(left, registry=registry)
    right_values = normalize_authority_list(right, registry=registry)
    unmatched_right = set(range(len(right_values)))
    matches: list[dict[str, Any]] = []
    unmatched_left: list[str] = []

    for left_value in left_values:
        best_index: int | None = None
        best_comparison: AuthorityComparison | None = None

        for index in sorted(unmatched_right):
            comparison = compare_authorities(
                left_value,
                right_values[index],
                registry=registry,
                equivalent_threshold=equivalent_threshold,
            )

            if (
                best_comparison is None
                or comparison.total_score > best_comparison.total_score
            ):
                best_index = index
                best_comparison = comparison

        if (
            best_index is None
            or best_comparison is None
            or not best_comparison.equivalent
        ):
            unmatched_left.append(left_value)
            continue

        unmatched_right.remove(best_index)
        matches.append(
            {
                "left": left_value,
                "right": right_values[best_index],
                "comparison": best_comparison.to_dict(),
            }
        )

    return {
        "schema_version": AUTHORITY_SCHEMA_VERSION,
        "generated_at": datetime.now(UTC)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "matches": matches,
        "unmatched_left": unmatched_left,
        "unmatched_right": [
            right_values[index]
            for index in sorted(unmatched_right)
        ],
        "equivalent": (
            not unmatched_left
            and not unmatched_right
        ),
    }

