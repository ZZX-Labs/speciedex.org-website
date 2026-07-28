from __future__ import annotations

import os
import signal
import sys
import time
from pathlib import Path
from typing import Callable


class DaemonController:
    def __init__(self, pid_file: Path, log_file: Path) -> None:
        self.pid_file = pid_file
        self.log_file = log_file
        self.pid_file.parent.mkdir(parents=True, exist_ok=True)
        self.log_file.parent.mkdir(parents=True, exist_ok=True)

    def _read_pid(self) -> int | None:
        try:
            return int(self.pid_file.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            return None

    def _alive(self, pid: int) -> bool:
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def start(self, target: Callable[[], None]) -> int:
        existing = self._read_pid()
        if existing and self._alive(existing):
            print(f"terminal-api already running with PID {existing}")
            return 1

        if os.name == "nt":
            print("Background daemonization is not supported on Windows; use foreground or a service wrapper.")
            return 2

        pid = os.fork()
        if pid > 0:
            self.pid_file.write_text(str(pid), encoding="utf-8")
            print(f"started terminal-api with PID {pid}")
            return 0

        os.setsid()
        with self.log_file.open("ab", buffering=0) as log:
            os.dup2(log.fileno(), sys.stdout.fileno())
            os.dup2(log.fileno(), sys.stderr.fileno())
            target()
        return 0

    def stop(self) -> int:
        pid = self._read_pid()
        if not pid:
            print("terminal-api is not running")
            return 1
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            self.pid_file.unlink(missing_ok=True)
            return 1
        for _ in range(50):
            if not self._alive(pid):
                self.pid_file.unlink(missing_ok=True)
                print("stopped terminal-api")
                return 0
            time.sleep(0.1)
        print(f"terminal-api PID {pid} did not stop")
        return 2

    def status(self) -> int:
        pid = self._read_pid()
        if pid and self._alive(pid):
            print(f"terminal-api running with PID {pid}")
            return 0
        print("terminal-api is not running")
        return 1
