"""Accept observed provider scans only when every registered source passed."""
from __future__ import annotations


def check_scan(definitions, report):
    expected = {item["name"] for item in definitions}
    skipped = {item.get("provider"): item.get("reason") for item in report.get("skipped", [])}
    observed, duplicates = {}, set()
    for item in report.get("providers", []):
        name = item.get("provider")
        if name in observed:
            duplicates.add(name)
        observed[name] = item
    results = []
    for name in sorted(expected):
        item = observed.get(name)
        if name in duplicates:
            status, reason = "failed", "duplicate scan result"
        elif name in skipped:
            status, reason = "blocked", skipped[name]
        elif item is None:
            status, reason = "unobserved", "provider was not executed"
        elif item.get("error"):
            status, reason = "failed", str(item["error"])
        elif item.get("status") not in {None, "passed", "completed"}:
            status, reason = "failed", "scan did not report successful execution"
        elif item.get("rejected", 0):
            status, reason = "degraded", "rejected records require inspection"
        elif not isinstance(item.get("fetched"), int) or item["fetched"] < 0:
            status, reason = "failed", "missing observed fetched record count"
        else:
            status, reason = "passed", None
        results.append({"provider": name, "status": status, "reason": reason})
    passed = sum(item["status"] == "passed" for item in results)
    return {"schema_version": 1, "method": "observed_all_provider_scan_results", "providers": len(expected),
            "passed": passed, "not_passed": len(expected) - passed,
            "all_operational": bool(expected) and passed == len(expected), "results": results}
