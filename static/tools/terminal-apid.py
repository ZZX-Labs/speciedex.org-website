#!/usr/bin/env python3
"""Daemon wrapper for the Speciedex Terminal API."""
from __future__ import annotations

import argparse
import os
import signal
import sys
from pathlib import Path

TOOLS_ROOT = Path(__file__).resolve().parent
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from terminal.config import APIConfig
from terminal.server import TerminalAPIServer
from terminal.daemon import DaemonController


def main() -> int:
    parser = argparse.ArgumentParser(prog="terminal-apid.py")
    parser.add_argument("action", choices=["start", "stop", "restart", "status", "foreground"])
    parser.add_argument("--config", type=Path)
    parser.add_argument("--repo-root", type=Path)
    parser.add_argument("--pid-file", type=Path)
    args = parser.parse_args()

    config = APIConfig.load(args.config, args.repo_root)
    controller = DaemonController(
        pid_file=args.pid_file or config.runtime_dir / "terminal-api.pid",
        log_file=config.runtime_dir / "terminal-api.log",
    )

    if args.action == "foreground":
        TerminalAPIServer(config).serve_forever()
        return 0
    if args.action == "start":
        return controller.start(lambda: TerminalAPIServer(config).serve_forever())
    if args.action == "stop":
        return controller.stop()
    if args.action == "restart":
        controller.stop()
        return controller.start(lambda: TerminalAPIServer(config).serve_forever())
    return controller.status()


if __name__ == "__main__":
    raise SystemExit(main())
