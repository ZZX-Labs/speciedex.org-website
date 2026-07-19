#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/lineage.py

Taxonomic lineage normalization, comparison, traversal, validation, and
serialization utilities.

This module owns:

- normalized lineage objects,
- ordered rank/name mappings,
- lineage construction from Taxon records,
- lineage construction from provider rows,
- parent and ancestor lookup,
- lineage merging,
- lineage comparison,
- divergence detection,
- lineage scoring,
- lineage validation,
- lineage fingerprints,
- lineage serialization,
- compatibility helpers for reconciliation and archive storage.

The taxonomy.py module owns rank and name normalization policy. This module
builds higher-level lineage behavior on top of that policy.

Copyright (c) 2026 ZZX-Laboratories

Licensed under the MIT License.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator, Mapping, Sequence

from providers.common import Taxon

from .taxonomy import (
    LINEAGE_FIELDS,
    PRIMARY_RANKS,
    RANK_ORDER,
    compare_ranks,
    normalize_key,
    normalize_rank,
    normalize_taxon_name,
    parent_rank,
    rank_index,
    rank_sort_key,
)


LINEAGE_SCHEMA_VERSION = 1

DEFAULT_COMPARISON_RANKS = (
    "domain",
    "kingdom",
    "phylum",
    "class",
    "order",
    "family",
    "genus",
)

DEFAULT_SCORE_WEIGHTS: dict[str, int] = {
    "domain": 12,
    "superkingdom": 12,
    "kingdom": 16,
    "subkingdom": 4,
    "infrakingdom": 3,
    "superphylum": 3,
    "phylum": 10,
    "subphylum": 3,
    "infraphylum": 2,
    "superclass": 2,
    "class": 8,
    "subclass": 2,
    "infraclass": 2,
    "superorder": 2,
    "order": 8,
    "suborder": 2,
    "infraorder": 2,
    "parvorder": 1,
    "superfamily": 2,
    "family": 10,
    "subfamily": 3,
    "tribe": 2,
    "subtribe": 1,
    "genus": 12,
    "subgenus": 3,
    "section": 1,
    "subsection": 1,
    "series": 1,
    "subseries": 1,
    "species": 8,
    "subspecies": 4,
    "variety": 3,
    "subvariety": 2,
    "form": 2,
    "subform": 1,
    "strain": 2,
    "cultivar": 2,
    "pathovar": 2,
    "serovar": 2,
    "biovar": 2,
    "isolate": 1,
    "hybrid": 1,
    "virus": 2,
    "clade": 1,
    "unranked": 0,
}


class LineageError(ValueError):
    """Raised when lineage data cannot be normalized safely."""


@dataclass(slots=True, frozen=True)
class LineageNode:
    """One normalized taxonomic lineage node."""

    rank: str
    name: str
    provider_id: str = ""
    authorship: str = ""
    status: str = ""
    metadata: dict[str, Any] = field(
        default_factory=dict
    )

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible lineage node."""

        return {
            "rank": self.rank,
            "name": self.name,
            "provider_id": self.provider_id,
            "authorship": self.authorship,
            "status": self.status,
            "metadata": dict(
                self.metadata
            ),
        }


@dataclass(slots=True)
class LineageValidation:
    """Validation result for one lineage."""

    valid: bool
    errors: list[str] = field(
        default_factory=list
    )
    warnings: list[str] = field(
        default_factory=list
    )

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
        }


@dataclass(slots=True)
class LineageComparison:
    """Comparison result for two lineages."""

    score: int
    maximum_score: int
    normalized_score: float
    matched: dict[str, str]
    mismatched: dict[
        str,
        tuple[str, str],
    ]
    only_left: dict[str, str]
    only_right: dict[str, str]
    first_divergence_rank: str | None
    shared_ancestor_rank: str | None
    shared_ancestor_name: str | None

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible lineage comparison."""

        return {
            "score": self.score,
            "maximum_score": self.maximum_score,
            "normalized_score": round(
                self.normalized_score,
                6,
            ),
            "matched": dict(
                self.matched
            ),
            "mismatched": {
                rank: {
                    "left": values[0],
                    "right": values[1],
                }
                for rank, values
                in self.mismatched.items()
            },
            "only_left": dict(
                self.only_left
            ),
            "only_right": dict(
                self.only_right
            ),
            "first_divergence_rank": (
                self.first_divergence_rank
            ),
            "shared_ancestor_rank": (
                self.shared_ancestor_rank
            ),
            "shared_ancestor_name": (
                self.shared_ancestor_name
            ),
        }


@dataclass(slots=True)
class LineageMergeResult:
    """Result of merging two lineages."""

    lineage: Lineage
    conflicts: dict[
        str,
        tuple[str, str],
    ]
    added_from_left: list[str]
    added_from_right: list[str]
    preferred_source: str

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible merge result."""

        return {
            "lineage": self.lineage.to_dict(),
            "conflicts": {
                rank: {
                    "left": values[0],
                    "right": values[1],
                }
                for rank, values
                in self.conflicts.items()
            },
            "added_from_left": list(
                self.added_from_left
            ),
            "added_from_right": list(
                self.added_from_right
            ),
            "preferred_source": (
                self.preferred_source
            ),
        }


class Lineage:
    """
    Ordered normalized taxonomic lineage.

    A lineage contains at most one node per normalized rank. Nodes are emitted
    in taxonomic hierarchy order.
    """

    def __init__(
        self,
        nodes: Iterable[
            LineageNode
            | Mapping[str, Any]
            | tuple[str, Any]
        ] | None = None,
    ) -> None:
        self._nodes: dict[
            str,
            LineageNode,
        ] = {}

        if nodes is not None:
            for node in nodes:
                self.add(node)

    def __len__(self) -> int:
        return len(
            self._nodes
        )

    def __bool__(self) -> bool:
        return bool(
            self._nodes
        )

    def __contains__(
        self,
        rank: object,
    ) -> bool:
        if not isinstance(rank, str):
            return False

        return normalize_rank(
            rank
        ) in self._nodes

    def __iter__(
        self,
    ) -> Iterator[LineageNode]:
        for rank in sorted(
            self._nodes,
            key=rank_sort_key,
        ):
            yield self._nodes[rank]

    def __getitem__(
        self,
        rank: str,
    ) -> LineageNode:
        normalized_rank = normalize_rank(
            rank
        )

        return self._nodes[
            normalized_rank
        ]

    def copy(self) -> Lineage:
        """Return an independent lineage copy."""

        return Lineage(
            node.to_dict()
            for node in self
        )

    def add(
        self,
        node: LineageNode
        | Mapping[str, Any]
        | tuple[str, Any],
        *,
        overwrite: bool = True,
    ) -> LineageNode | None:
        """
        Add one lineage node.

        Returns the previous node when a rank was replaced.
        """

        normalized = self._coerce_node(
            node
        )

        previous = self._nodes.get(
            normalized.rank
        )

        if (
            previous is not None
            and not overwrite
        ):
            return previous

        self._nodes[
            normalized.rank
        ] = normalized

        return previous

    def set(
        self,
        rank: Any,
        name: Any,
        *,
        provider_id: Any = "",
        authorship: Any = "",
        status: Any = "",
        metadata: Mapping[str, Any] | None = None,
        overwrite: bool = True,
    ) -> LineageNode | None:
        """Set one normalized lineage node."""

        return self.add(
            LineageNode(
                rank=normalize_rank(
                    rank
                ),
                name=normalize_taxon_name(
                    name
                ),
                provider_id=str(
                    provider_id
                    if provider_id is not None
                    else ""
                ).strip(),
                authorship=str(
                    authorship
                    if authorship is not None
                    else ""
                ).strip(),
                status=str(
                    status
                    if status is not None
                    else ""
                ).strip(),
                metadata=dict(
                    metadata or {}
                ),
            ),
            overwrite=overwrite,
        )

    def remove(
        self,
        rank: Any,
    ) -> LineageNode | None:
        """Remove one lineage rank."""

        return self._nodes.pop(
            normalize_rank(rank),
            None,
        )

    def clear(self) -> None:
        """Remove all lineage nodes."""

        self._nodes.clear()

    def get(
        self,
        rank: Any,
        default: str = "",
    ) -> str:
        """Return a lineage name by rank."""

        node = self._nodes.get(
            normalize_rank(rank)
        )

        return (
            node.name
            if node is not None
            else default
        )

    def node(
        self,
        rank: Any,
    ) -> LineageNode | None:
        """Return a lineage node by rank."""

        return self._nodes.get(
            normalize_rank(rank)
        )

    def ranks(self) -> list[str]:
        """Return ranks in hierarchy order."""

        return [
            node.rank
            for node in self
        ]

    def names(self) -> list[str]:
        """Return names in hierarchy order."""

        return [
            node.name
            for node in self
        ]

    def items(
        self,
    ) -> list[tuple[str, str]]:
        """Return ordered rank/name pairs."""

        return [
            (
                node.rank,
                node.name,
            )
            for node in self
        ]

    def to_mapping(
        self,
    ) -> dict[str, str]:
        """Return an ordered rank/name mapping."""

        return {
            node.rank: node.name
            for node in self
        }

    def to_dict(
        self,
    ) -> dict[str, Any]:
        """Return a JSON-compatible lineage object."""

        return {
            "schema_version": (
                LINEAGE_SCHEMA_VERSION
            ),
            "nodes": [
                node.to_dict()
                for node in self
            ],
            "primary": self.primary(),
            "fingerprint": (
                self.fingerprint()
            ),
        }

    def primary(self) -> dict[str, str]:
        """Return primary lineage fields."""

        return {
            rank: self.get(rank)
            for rank in LINEAGE_FIELDS
        }

    def ancestors_of(
        self,
        rank: Any,
        *,
        inclusive: bool = False,
    ) -> Lineage:
        """Return all nodes above the requested rank."""

        normalized_rank = normalize_rank(
            rank
        )

        target_index = rank_index(
            normalized_rank
        )

        return Lineage(
            node
            for node in self
            if (
                rank_index(
                    node.rank
                )
                < target_index
                or (
                    inclusive
                    and node.rank
                    == normalized_rank
                )
            )
        )

    def descendants_of(
        self,
        rank: Any,
        *,
        inclusive: bool = False,
    ) -> Lineage:
        """Return all nodes below the requested rank."""

        normalized_rank = normalize_rank(
            rank
        )

        target_index = rank_index(
            normalized_rank
        )

        return Lineage(
            node
            for node in self
            if (
                rank_index(
                    node.rank
                )
                > target_index
                or (
                    inclusive
                    and node.rank
                    == normalized_rank
                )
            )
        )

    def parent_of(
        self,
        rank: Any,
    ) -> LineageNode | None:
        """Return the closest present parent node."""

        normalized_rank = normalize_rank(
            rank
        )

        target_index = rank_index(
            normalized_rank
        )

        candidates = [
            node
            for node in self
            if rank_index(
                node.rank
            ) < target_index
        ]

        if not candidates:
            return None

        return max(
            candidates,
            key=lambda node: rank_index(
                node.rank
            ),
        )

    def child_of(
        self,
        rank: Any,
    ) -> LineageNode | None:
        """Return the closest present child node."""

        normalized_rank = normalize_rank(
            rank
        )

        target_index = rank_index(
            normalized_rank
        )

        candidates = [
            node
            for node in self
            if rank_index(
                node.rank
            ) > target_index
        ]

        if not candidates:
            return None

        return min(
            candidates,
            key=lambda node: rank_index(
                node.rank
            ),
        )

    def highest(self) -> LineageNode | None:
        """Return the highest-ranked present node."""

        try:
            return next(
                iter(self)
            )
        except StopIteration:
            return None

    def lowest(self) -> LineageNode | None:
        """Return the lowest-ranked present node."""

        nodes = list(self)

        return (
            nodes[-1]
            if nodes
            else None
        )

    def path(
        self,
        *,
        separator: str = " > ",
        include_ranks: bool = False,
    ) -> str:
        """Return a human-readable lineage path."""

        if include_ranks:
            values = [
                f"{node.rank}:{node.name}"
                for node in self
            ]
        else:
            values = [
                node.name
                for node in self
            ]

        return separator.join(
            values
        )

    def fingerprint(
        self,
        *,
        ranks: Sequence[str] | None = None,
        algorithm: str = "sha256",
    ) -> str:
        """Return a deterministic fingerprint of selected lineage ranks."""

        selected = (
            tuple(
                normalize_rank(rank)
                for rank in ranks
            )
            if ranks is not None
            else tuple(
                node.rank
                for node in self
            )
        )

        payload = [
            (
                rank,
                normalize_key(
                    self.get(rank)
                ),
            )
            for rank in selected
            if self.get(rank)
        ]

        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=False,
            separators=(",", ":"),
        ).encode("utf-8")

        try:
            digest = hashlib.new(
                algorithm
            )
        except ValueError as error:
            raise LineageError(
                f"Unsupported fingerprint algorithm: "
                f"{algorithm}"
            ) from error

        digest.update(encoded)

        return digest.hexdigest()

    def validate(
        self,
        *,
        require_primary_order: bool = True,
    ) -> LineageValidation:
        """Validate lineage structure."""

        errors: list[str] = []
        warnings: list[str] = []

        seen_names: dict[
            str,
            str,
        ] = {}

        previous_index: int | None = None

        for node in self:
            if not node.name:
                errors.append(
                    f"Lineage node {node.rank!r} "
                    "has an empty name."
                )

            current_index = rank_index(
                node.rank
            )

            if (
                previous_index is not None
                and current_index
                <= previous_index
            ):
                errors.append(
                    "Lineage ranks are not in strict "
                    "hierarchy order."
                )

            previous_index = current_index

            key = normalize_key(
                node.name
            )

            if (
                key in seen_names
                and seen_names[key]
                != node.rank
            ):
                warnings.append(
                    f"Lineage name {node.name!r} "
                    "appears at multiple ranks: "
                    f"{seen_names[key]} and "
                    f"{node.rank}."
                )

            seen_names[key] = node.rank

        if require_primary_order:
            present_primary = [
                rank
                for rank in PRIMARY_RANKS
                if rank in self
            ]

            for left, right in zip(
                present_primary,
                present_primary[1:],
            ):
                if compare_ranks(
                    left,
                    right,
                ) >= 0:
                    errors.append(
                        "Primary lineage ranks are "
                        "out of order."
                    )

        if (
            "species" in self
            and "genus" in self
        ):
            species_name = self.get(
                "species"
            )

            genus_name = self.get(
                "genus"
            )

            first_token = (
                species_name.split()[0]
                if species_name.split()
                else ""
            )

            if (
                first_token
                and normalize_key(
                    first_token
                )
                != normalize_key(
                    genus_name
                )
            ):
                errors.append(
                    "Species name genus does not match "
                    "lineage genus."
                )

        return LineageValidation(
            valid=not errors,
            errors=errors,
            warnings=warnings,
        )

    @staticmethod
    def _coerce_node(
        value: LineageNode
        | Mapping[str, Any]
        | tuple[str, Any],
    ) -> LineageNode:
        """Convert supported node input into LineageNode."""

        if isinstance(
            value,
            LineageNode,
        ):
            rank = normalize_rank(
                value.rank
            )

            name = normalize_taxon_name(
                value.name
            )

            if not name:
                raise LineageError(
                    "Lineage node name cannot be empty."
                )

            return LineageNode(
                rank=rank,
                name=name,
                provider_id=str(
                    value.provider_id
                ).strip(),
                authorship=str(
                    value.authorship
                ).strip(),
                status=str(
                    value.status
                ).strip(),
                metadata=dict(
                    value.metadata
                ),
            )

        if isinstance(
            value,
            tuple,
        ):
            if len(value) != 2:
                raise LineageError(
                    "Lineage tuple nodes must contain "
                    "exactly rank and name."
                )

            rank, name = value

            return Lineage._coerce_node(
                {
                    "rank": rank,
                    "name": name,
                }
            )

        if not isinstance(
            value,
            Mapping,
        ):
            raise LineageError(
                "Unsupported lineage node type: "
                f"{type(value).__name__}"
            )

        rank = (
            value.get("rank")
            or value.get("rankName")
            or value.get("taxonRank")
            or value.get("taxonomicRank")
        )

        name = (
            value.get("name")
            or value.get("scientific_name")
            or value.get("scientificName")
            or value.get("canonical_name")
            or value.get("canonicalName")
            or value.get("taxonName")
        )

        normalized_rank = normalize_rank(
            rank
        )

        normalized_name = normalize_taxon_name(
            name
        )

        if not normalized_name:
            raise LineageError(
                "Lineage node name cannot be empty."
            )

        metadata = value.get(
            "metadata",
            {},
        )

        if not isinstance(
            metadata,
            Mapping,
        ):
            metadata = {}

        return LineageNode(
            rank=normalized_rank,
            name=normalized_name,
            provider_id=str(
                value.get(
                    "provider_id",
                    value.get(
                        "providerId",
                        value.get(
                            "id",
                            "",
                        ),
                    ),
                )
                or ""
            ).strip(),
            authorship=str(
                value.get(
                    "authorship",
                    value.get(
                        "authority",
                        "",
                    ),
                )
                or ""
            ).strip(),
            status=str(
                value.get(
                    "status",
                    ""
                )
                or ""
            ).strip(),
            metadata=dict(
                metadata
            ),
        )


def lineage_from_mapping(
    value: Mapping[str, Any],
) -> Lineage:
    """Create a lineage from a rank/name mapping."""

    lineage = Lineage()

    for rank, name in value.items():
        if isinstance(
            name,
            Mapping,
        ):
            item = dict(name)
            item.setdefault(
                "rank",
                rank,
            )

            try:
                lineage.add(item)
            except LineageError:
                continue

        else:
            normalized_name = (
                normalize_taxon_name(
                    name
                )
            )

            if not normalized_name:
                continue

            lineage.set(
                rank,
                normalized_name,
            )

    return lineage


def lineage_from_rows(
    rows: Iterable[
        Mapping[str, Any]
    ],
) -> Lineage:
    """Create a lineage from provider hierarchy rows."""

    lineage = Lineage()

    for row in rows:
        if not isinstance(
            row,
            Mapping,
        ):
            continue

        try:
            lineage.add(row)
        except LineageError:
            continue

    return lineage


def lineage_from_taxon(
    record: Taxon,
    *,
    include_record: bool = True,
) -> Lineage:
    """Create a lineage from a normalized Taxon."""

    lineage = Lineage()

    for rank, name in (
        (
            "kingdom",
            record.kingdom,
        ),
        (
            "phylum",
            record.phylum,
        ),
        (
            "class",
            record.class_name,
        ),
        (
            "order",
            record.order,
        ),
        (
            "family",
            record.family,
        ),
        (
            "genus",
            record.genus,
        ),
    ):
        if normalize_taxon_name(name):
            lineage.set(
                rank,
                name,
            )

    if include_record:
        normalized_rank = normalize_rank(
            record.rank
        )

        if (
            normalized_rank
            and normalize_taxon_name(
                record.canonical_name
            )
        ):
            lineage.set(
                normalized_rank,
                record.canonical_name,
                provider_id=(
                    record.provider_id
                ),
                authorship=(
                    record.authorship
                ),
                status=record.status,
            )

    return lineage


def lineage_from_any(
    value: Any,
) -> Lineage:
    """Create a lineage from supported input forms."""

    if isinstance(value, Lineage):
        return value.copy()

    if isinstance(value, Taxon):
        return lineage_from_taxon(
            value
        )

    if isinstance(value, Mapping):
        nodes = value.get(
            "nodes"
        )

        if isinstance(nodes, list):
            return lineage_from_rows(
                nodes
            )

        return lineage_from_mapping(
            value
        )

    if isinstance(
        value,
        Iterable,
    ) and not isinstance(
        value,
        (str, bytes),
    ):
        return Lineage(value)

    raise LineageError(
        "Unsupported lineage source type: "
        f"{type(value).__name__}"
    )


def compare_lineages(
    left: Lineage
    | Taxon
    | Mapping[str, Any]
    | Iterable[Mapping[str, Any]],
    right: Lineage
    | Taxon
    | Mapping[str, Any]
    | Iterable[Mapping[str, Any]],
    *,
    ranks: Sequence[str] | None = None,
    weights: Mapping[str, int] | None = None,
    penalize_mismatch: bool = False,
) -> LineageComparison:
    """Compare two lineages using weighted normalized rank matches."""

    left_lineage = lineage_from_any(
        left
    )

    right_lineage = lineage_from_any(
        right
    )

    selected_ranks = (
        tuple(
            normalize_rank(rank)
            for rank in ranks
        )
        if ranks is not None
        else tuple(
            sorted(
                set(
                    left_lineage.ranks()
                )
                | set(
                    right_lineage.ranks()
                ),
                key=rank_sort_key,
            )
        )
    )

    score_weights = dict(
        DEFAULT_SCORE_WEIGHTS
    )

    if weights:
        for rank, weight in weights.items():
            score_weights[
                normalize_rank(rank)
            ] = max(
                0,
                int(weight),
            )

    matched: dict[str, str] = {}
    mismatched: dict[
        str,
        tuple[str, str],
    ] = {}
    only_left: dict[str, str] = {}
    only_right: dict[str, str] = {}

    score = 0
    maximum_score = 0
    first_divergence_rank: str | None = None
    shared_ancestor_rank: str | None = None
    shared_ancestor_name: str | None = None

    for rank in selected_ranks:
        left_name = left_lineage.get(
            rank
        )

        right_name = right_lineage.get(
            rank
        )

        weight = score_weights.get(
            rank,
            0,
        )

        if left_name and right_name:
            maximum_score += weight

            if normalize_key(
                left_name
            ) == normalize_key(
                right_name
            ):
                score += weight
                matched[rank] = left_name

                if first_divergence_rank is None:
                    shared_ancestor_rank = rank
                    shared_ancestor_name = (
                        left_name
                    )

            else:
                mismatched[rank] = (
                    left_name,
                    right_name,
                )

                if first_divergence_rank is None:
                    first_divergence_rank = (
                        rank
                    )

                if penalize_mismatch:
                    score -= weight

        elif left_name:
            only_left[rank] = left_name

        elif right_name:
            only_right[rank] = right_name

    if maximum_score > 0:
        normalized_score = max(
            0.0,
            min(
                1.0,
                score
                / maximum_score,
            ),
        )
    else:
        normalized_score = 0.0

    return LineageComparison(
        score=score,
        maximum_score=maximum_score,
        normalized_score=normalized_score,
        matched=matched,
        mismatched=mismatched,
        only_left=only_left,
        only_right=only_right,
        first_divergence_rank=(
            first_divergence_rank
        ),
        shared_ancestor_rank=(
            shared_ancestor_rank
        ),
        shared_ancestor_name=(
            shared_ancestor_name
        ),
    )


def merge_lineages(
    left: Lineage
    | Taxon
    | Mapping[str, Any]
    | Iterable[Mapping[str, Any]],
    right: Lineage
    | Taxon
    | Mapping[str, Any]
    | Iterable[Mapping[str, Any]],
    *,
    prefer: str = "left",
    keep_conflicting_metadata: bool = True,
) -> LineageMergeResult:
    """Merge two lineages while reporting conflicting ranks."""

    left_lineage = lineage_from_any(
        left
    )

    right_lineage = lineage_from_any(
        right
    )

    normalized_preference = (
        str(prefer).strip().casefold()
    )

    if normalized_preference not in {
        "left",
        "right",
    }:
        raise ValueError(
            "prefer must be 'left' or 'right'."
        )

    result = Lineage()
    conflicts: dict[
        str,
        tuple[str, str],
    ] = {}
    added_from_left: list[str] = []
    added_from_right: list[str] = []

    all_ranks = sorted(
        set(
            left_lineage.ranks()
        )
        | set(
            right_lineage.ranks()
        ),
        key=rank_sort_key,
    )

    for rank in all_ranks:
        left_node = left_lineage.node(
            rank
        )

        right_node = right_lineage.node(
            rank
        )

        if (
            left_node is not None
            and right_node is not None
        ):
            if normalize_key(
                left_node.name
            ) == normalize_key(
                right_node.name
            ):
                preferred_node = (
                    left_node
                    if normalized_preference
                    == "left"
                    else right_node
                )

                secondary_node = (
                    right_node
                    if preferred_node
                    is left_node
                    else left_node
                )

                metadata = dict(
                    preferred_node.metadata
                )

                if keep_conflicting_metadata:
                    for key, value in (
                        secondary_node.metadata.items()
                    ):
                        metadata.setdefault(
                            key,
                            value,
                        )

                result.add(
                    LineageNode(
                        rank=preferred_node.rank,
                        name=preferred_node.name,
                        provider_id=(
                            preferred_node.provider_id
                            or secondary_node.provider_id
                        ),
                        authorship=(
                            preferred_node.authorship
                            or secondary_node.authorship
                        ),
                        status=(
                            preferred_node.status
                            or secondary_node.status
                        ),
                        metadata=metadata,
                    )
                )

            else:
                conflicts[rank] = (
                    left_node.name,
                    right_node.name,
                )

                chosen = (
                    left_node
                    if normalized_preference
                    == "left"
                    else right_node
                )

                result.add(chosen)

        elif left_node is not None:
            result.add(left_node)
            added_from_left.append(rank)

        elif right_node is not None:
            result.add(right_node)
            added_from_right.append(rank)

    return LineageMergeResult(
        lineage=result,
        conflicts=conflicts,
        added_from_left=added_from_left,
        added_from_right=added_from_right,
        preferred_source=(
            normalized_preference
        ),
    )


def shared_ancestor(
    left: Lineage
    | Taxon
    | Mapping[str, Any]
    | Iterable[Mapping[str, Any]],
    right: Lineage
    | Taxon
    | Mapping[str, Any]
    | Iterable[Mapping[str, Any]],
) -> LineageNode | None:
    """Return the lowest shared ancestor before divergence."""

    comparison = compare_lineages(
        left,
        right,
    )

    if (
        comparison.shared_ancestor_rank
        is None
        or comparison.shared_ancestor_name
        is None
    ):
        return None

    return LineageNode(
        rank=(
            comparison.shared_ancestor_rank
        ),
        name=(
            comparison.shared_ancestor_name
        ),
    )


def first_divergence(
    left: Lineage
    | Taxon
    | Mapping[str, Any]
    | Iterable[Mapping[str, Any]],
    right: Lineage
    | Taxon
    | Mapping[str, Any]
    | Iterable[Mapping[str, Any]],
) -> tuple[
    str,
    str,
    str,
] | None:
    """Return the first rank at which two lineages disagree."""

    comparison = compare_lineages(
        left,
        right,
    )

    rank = (
        comparison.first_divergence_rank
    )

    if rank is None:
        return None

    values = comparison.mismatched.get(
        rank
    )

    if values is None:
        return None

    return (
        rank,
        values[0],
        values[1],
    )


def lineage_score(
    left: Lineage
    | Taxon
    | Mapping[str, Any]
    | Iterable[Mapping[str, Any]],
    right: Lineage
    | Taxon
    | Mapping[str, Any]
    | Iterable[Mapping[str, Any]],
    *,
    ranks: Sequence[str] = (
        DEFAULT_COMPARISON_RANKS
    ),
    weights: Mapping[str, int] | None = None,
) -> int:
    """Return the integer weighted lineage score."""

    return compare_lineages(
        left,
        right,
        ranks=ranks,
        weights=weights,
    ).score


def lineage_similarity(
    left: Lineage
    | Taxon
    | Mapping[str, Any]
    | Iterable[Mapping[str, Any]],
    right: Lineage
    | Taxon
    | Mapping[str, Any]
    | Iterable[Mapping[str, Any]],
    *,
    ranks: Sequence[str] = (
        DEFAULT_COMPARISON_RANKS
    ),
    weights: Mapping[str, int] | None = None,
) -> float:
    """Return normalized lineage similarity from 0.0 to 1.0."""

    return compare_lineages(
        left,
        right,
        ranks=ranks,
        weights=weights,
    ).normalized_score


def primary_lineage_mapping(
    value: Lineage
    | Taxon
    | Mapping[str, Any]
    | Iterable[Mapping[str, Any]],
) -> dict[str, str]:
    """Return the primary normalized lineage mapping."""

    return lineage_from_any(
        value
    ).primary()


def nearest_present_parent(
    lineage: Lineage
    | Taxon
    | Mapping[str, Any]
    | Iterable[Mapping[str, Any]],
    rank: Any,
) -> LineageNode | None:
    """Return the closest present ancestor for a rank."""

    return lineage_from_any(
        lineage
    ).parent_of(
        rank
    )


def expected_parent_rank(
    rank: Any,
) -> str | None:
    """Compatibility wrapper around taxonomy.parent_rank."""

    return parent_rank(
        rank
    )
