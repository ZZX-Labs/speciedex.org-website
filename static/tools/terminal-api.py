#!/usr/bin/env python3
"""
Speciedex Terminal API
Main headless HTTP entry point for the Speciedex Pages frontend.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

TOOLS_ROOT = Path(__file__).resolve().parent
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from terminal.config import APIConfig
from terminal.server import TerminalAPIServer


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="terminal-api.py",
        description="Run the Speciedex Terminal API server.",
    )
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--repo-root", type=Path, default=None)
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--log-level", default=None)
    parser.add_argument("--generate-static", action="store_true")
    parser.add_argument("--check", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    config = APIConfig.load(
        config_path=args.config,
        repo_root=args.repo_root,
        overrides={
            "host": args.host,
            "port": args.port,
            "log_level": args.log_level,
        },
    )
    logging.basicConfig(
        level=getattr(logging, config.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    server = TerminalAPIServer(config)

    if args.check:
        report = server.check()
        print(report.to_json())
        return 0 if report.ok else 1

    if args.generate_static:
        result = server.generate_static()
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
