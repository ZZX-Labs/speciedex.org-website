from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Iterator


class StreamService:
    def __init__(self, taxonomy_root: Path, interval_ms: int = 250) -> None:
        self.taxonomy_root = taxonomy_root
        self.interval = max(0, interval_ms) / 1000.0

    def iter_records(self, limit: int = 100) -> Iterator[str]:
        emitted = 0
        candidates = list(self.taxonomy_root.rglob("*.jsonl")) if self.taxonomy_root.exists() else []
        for path in candidates:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    text = line.strip()
                    if not text:
                        continue
                    try:
                        payload = json.loads(text)
                    except json.JSONDecodeError:
                        payload = {"value": text}
                    yield f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"
                    emitted += 1
                    if emitted >= limit:
                        return
                    if self.interval:
                        time.sleep(self.interval)
        if emitted == 0:
            yield 'event: heartbeat\ndata: {"status":"idle"}\n\n'
