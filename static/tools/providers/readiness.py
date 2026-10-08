"""Classify one registry-wide provider scan without conflating availability with correctness.

The provider registry deliberately contains a mixture of live APIs, local exports,
credential-backed sources, and optional reference feeds. A normal public-database
refresh therefore needs two distinct health questions:

* ``all_operational`` -- did every registered provider execute successfully?
* ``publishable`` -- did the scan account for the complete registry and produce at
  least one successful source without a structural scan/report failure?

Blocked providers remain visible and count against ``all_operational``. They do not,
by themselves, make a canonical-database rebuild unsafe.
"""
from __future__ import annotations

from collections import Counter
from typing import Any, Iterable, Mapping


def _provider_name(item: Mapping[str, Any]) -> str:
    return str(item.get("name") or "").strip()


def check_scan(definitions: Iterable[Mapping[str, Any]], report: Mapping[str, Any]) -> dict[str, Any]:
    """Return strict operational health and publication safety for a provider scan."""

    expected = {
        name
        for item in definitions
        if isinstance(item, Mapping)
        if (name := _provider_name(item))
    }
    skipped = {
        str(item.get("provider") or "").strip(): item.get("reason")
        for item in report.get("skipped", [])
        if isinstance(item, Mapping) and str(item.get("provider") or "").strip()
    }

    observed: dict[str, Mapping[str, Any]] = {}
    duplicates: set[str] = set()
    unexpected: set[str] = set()

    for item in report.get("providers", []):
        if not isinstance(item, Mapping):
            continue
        name = str(item.get("provider") or "").strip()
        if not name:
            continue
        if name in observed:
            duplicates.add(name)
        observed[name] = item
        if name not in expected:
            unexpected.add(name)

    results: list[dict[str, Any]] = []

    for name in sorted(expected):
        item = observed.get(name)
        fatal = False

        if name in duplicates:
            status, reason, fatal = "failed", "duplicate scan result", True
        elif name in skipped:
            status, reason = "blocked", skipped[name]
        elif item is None:
            status, reason, fatal = "unobserved", "provider was not accounted for by the scan", True
        elif item.get("error"):
            # An attempted upstream may fail transiently. Preserve that fact, but do
            # not invalidate a rebuild from the already-committed canonical archive.
            status, reason = "failed", str(item["error"])
        elif item.get("status") not in {None, "passed", "completed"}:
            status, reason = "failed", "scan did not report successful execution"
        elif item.get("rejected", 0):
            status, reason = "degraded", "rejected records require inspection"
        elif not isinstance(item.get("fetched"), int) or isinstance(item.get("fetched"), bool) or item["fetched"] < 0:
            status, reason, fatal = "failed", "missing observed fetched record count", True
        else:
            status, reason = "passed", None

        result = {
            "provider": name,
            "status": status,
            "reason": reason,
        }
        if fatal:
            result["fatal"] = True
        results.append(result)

    counts = Counter(item["status"] for item in results)
    passed = counts["passed"]
    blocked = counts["blocked"]
    failed = counts["failed"]
    degraded = counts["degraded"]
    unobserved = counts["unobserved"]
    fatal = sum(bool(item.get("fatal")) for item in results)
    accounted = len(expected) - unobserved
    coverage_complete = bool(expected) and unobserved == 0
    all_operational = bool(expected) and passed == len(expected)

    # Publication safety is intentionally weaker than strict upstream health.  It
    # requires a complete registry accounting, at least one successful source, and
    # no malformed/structurally incomplete scan result.  Blocked optional sources,
    # transient HTTP failures and rejected-row degradation remain prominently
    # reported but do not strand a rebuild of the canonical corpus.
    publishable = coverage_complete and passed > 0 and fatal == 0

    if all_operational:
        health = "healthy"
    elif publishable:
        health = "degraded"
    else:
        health = "blocked"

    return {
        "schema_version": 1,
        "method": "observed_all_provider_scan_results",
        "providers": len(expected),
        "accounted": accounted,
        "passed": passed,
        "blocked": blocked,
        "failed": failed,
        "degraded": degraded,
        "unobserved": unobserved,
        "fatal": fatal,
        "not_passed": len(expected) - passed,
        "coverage_complete": coverage_complete,
        "all_operational": all_operational,
        "publishable": publishable,
        "health": health,
        "unexpected_providers": sorted(unexpected),
        "results": results,
    }
