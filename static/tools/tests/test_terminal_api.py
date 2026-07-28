from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
import sys

TOOLS_ROOT = Path(__file__).resolve().parents[1]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from terminal.cache import TTLCache
from terminal.config import APIConfig
from terminal.router import Router
from terminal.models import APIResponse
from terminal.server import TerminalAPIServer


class TerminalAPITests(unittest.TestCase):
    def test_cache(self) -> None:
        cache = TTLCache(limit=2, ttl=30)
        cache.set("a", 1)
        self.assertEqual(cache.get("a"), 1)

    def test_router(self) -> None:
        router = Router()
        router.add("GET", "/health", lambda q, b: APIResponse(200, {"ok": True}))
        response = router.dispatch("GET", "/health", {}, b"")
        self.assertEqual(response.status, 200)
        self.assertTrue(response.payload["ok"])

    def test_static_build(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "static/data/taxonomy").mkdir(parents=True)
            config = APIConfig(repo_root=root)
            server = TerminalAPIServer(config)
            result = server.generate_static()
            self.assertTrue((config.static_api_root / "health.json").exists())
            self.assertIn("files", result)


if __name__ == "__main__":
    unittest.main()
