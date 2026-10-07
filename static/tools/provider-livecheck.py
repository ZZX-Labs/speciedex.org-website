#!/usr/bin/env python3
"""Non-mutating live/runtime verification for configured Speciedex providers.

Unlike provider-conformance.py, this command uses the real configured endpoint,
credentials, or dataset. It never writes to the canonical archive; provider
state is placed in a temporary directory. Run it on a deployment host that has
network access and any required credentials/licensed datasets.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

TOOLS_ROOT = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_ROOT.parent.parent
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from providers.common import HTTPClient, ProviderError  # noqa: E402
from providers.loader import load_provider  # noqa: E402


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_registry(repo_root: Path) -> list[dict[str, Any]]:
    data = json.loads((repo_root / "static/tools/providers.json").read_text(encoding="utf-8"))
    raw = data.get("providers", data) if isinstance(data, dict) else data
    return [dict(item) for item in raw if isinstance(item, dict)]


def boolish(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None or value == "":
        return default
    return str(value).strip().lower() not in {"0", "false", "no", "off", "disabled"}


def prerequisites(repo_root: Path, definition: dict[str, Any]) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    if not boolish(definition.get("enabled"), True):
        reasons.append("disabled")

    configured = definition.get("path") or definition.get("archive") or definition.get("source_path")
    if configured:
        path = Path(str(configured))
        if not path.is_absolute():
            path = repo_root / path
        if not path.exists():
            reasons.append(f"missing_dataset:{path}")

    runtime_mode = str(definition.get("runtime_mode") or "").strip().lower()
    credential_default = runtime_mode not in {"local_dataset", "darwin_core_archive"}
    if boolish(definition.get("credentials_required_for_ingest"), credential_default):
        required = definition.get("required_env") or []
        if isinstance(required, str):
            required = [required]
        for variable in required:
            if variable and not os.getenv(str(variable)):
                reasons.append(f"missing_env:{variable}")

    return not reasons, reasons


def run_one(repo_root: Path, definition: dict[str, Any], *, timeout: int, retries: int, batch_size: int) -> dict[str, Any]:
    name = str(definition.get("name") or "")
    ready, reasons = prerequisites(repo_root, definition)
    if not ready:
        return {"provider": name, "status": "blocked", "reasons": reasons}

    configured_batch = int(definition.get("batch_size") or batch_size)
    configured_batch = max(1, min(configured_batch, batch_size))
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix=f"speciedex-livecheck-{name}-") as td:
        http = HTTPClient(timeout=timeout, retries=retries, backoff=1.5)
        provider = load_provider(
            definition,
            http,
            Path(td) / f"{name}.json",
            configured_batch,
            repo_root,
        )
        try:
            batch = provider.fetch()
        except Exception as error:
            return {
                "provider": name,
                "status": "failed",
                "error": f"{type(error).__name__}: {error}",
                "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
                "requests": http.requests,
            }
    return {
        "provider": name,
        "status": "failed" if batch.rejected else "passed",
        "records": len(batch.records),
        "rejected": len(batch.rejected),
        "raw": batch.raw,
        "requests": batch.requests,
        "exhausted": batch.exhausted,
        "has_next_cursor": bool(batch.next_cursor),
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=REPO_ROOT)
    parser.add_argument("--provider", action="append", default=[])
    parser.add_argument("--timeout", type=int, default=15)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--batch-size", type=int, default=5)
    parser.add_argument("--json", action="store_true", dest="as_json")
    parser.add_argument("--write-report", type=Path)
    parser.add_argument("--require-all", action="store_true", help="Fail missing prerequisites as well as provider errors")
    args = parser.parse_args()

    repo_root = args.repo_root.resolve()
    definitions = load_registry(repo_root)
    selected = set(args.provider)
    if selected:
        unknown = selected - {str(item.get("name")) for item in definitions}
        if unknown:
            parser.error("unknown provider(s): " + ", ".join(sorted(unknown)))
        definitions = [item for item in definitions if item.get("name") in selected]

    results = [run_one(repo_root, item, timeout=max(1, args.timeout), retries=max(1, args.retries), batch_size=max(1, args.batch_size)) for item in definitions]
    report = {
        "schema_version": 1,
        "generated_at": now(),
        "method": "real_runtime_non_mutating_livecheck",
        "providers": len(results),
        "passed": sum(item["status"] == "passed" for item in results),
        "blocked": sum(item["status"] == "blocked" for item in results),
        "failed": sum(item["status"] == "failed" for item in results),
        "results": results,
    }

    if args.write_report:
        target = args.write_report
        if not target.is_absolute():
            target = repo_root / target
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if args.as_json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        for item in results:
            detail = ""
            if item["status"] == "blocked":
                detail = " " + ", ".join(item.get("reasons", []))
            elif item["status"] == "failed":
                detail = " " + str(item.get("error", ""))
            else:
                detail = f" records={item.get('records', 0)} requests={item.get('requests', 0)} elapsed_ms={item.get('elapsed_ms', 0)}"
            print(f"[{item['status'].upper()}] {item['provider']}{detail}")
        print(f"Livecheck: passed={report['passed']} blocked={report['blocked']} failed={report['failed']} total={report['providers']}")

    return 1 if report["failed"] or args.require_all and report["blocked"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
