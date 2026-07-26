#!/usr/bin/env python3
"""Headless PTY/WebSocket server for upstream cmatrix.

Runs only the installed cmatrix executable from:
https://github.com/abishekvashok/cmatrix
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import pty
import shutil
import signal
import struct
import termios
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web

LOG = logging.getLogger("cmatrix-server")
ALLOWED_SIGNALS = {"SIGINT": signal.SIGINT, "SIGTERM": signal.SIGTERM, "SIGHUP": signal.SIGHUP}
ALLOWED_FLAGS = {"-a", "-b", "-B", "-C", "-l", "-L", "-m", "-o", "-r", "-s", "-u", "-x", "-V", "-h"}


def bounded_int(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    try:
        return max(minimum, min(maximum, int(value)))
    except (TypeError, ValueError):
        return fallback


def validate_args(raw: Any) -> list[str]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > 32:
        raise ValueError("args must be an array of at most 32 values")
    result: list[str] = []
    for item in raw:
        value = str(item)
        if len(value) > 128 or "\x00" in value or "\n" in value or "\r" in value:
            raise ValueError("invalid cmatrix argument")
        if value.startswith("-") and value not in ALLOWED_FLAGS and not value.startswith("-d"):
            raise ValueError(f"cmatrix flag is not allowed: {value}")
        result.append(value)
    return result


@dataclass(slots=True)
class Settings:
    executable: str
    idle_timeout: int
    max_sessions: int
    allowed_origins: set[str]


class Session:
    def __init__(self, ws: web.WebSocketResponse, settings: Settings, columns: int, rows: int, args: list[str]):
        self.ws = ws
        self.settings = settings
        self.columns = columns
        self.rows = rows
        self.args = args
        self.pid: int | None = None
        self.master_fd: int | None = None
        self.reader_task: asyncio.Task[None] | None = None
        self.wait_task: asyncio.Task[None] | None = None
        self.last_activity = asyncio.get_running_loop().time()
        self.closed = False

    async def start(self) -> None:
        if self.pid is not None:
            return
        master_fd, slave_fd = pty.openpty()
        self.master_fd = master_fd
        self._resize(self.columns, self.rows)
        env = os.environ.copy()
        env.update({"TERM": "xterm-256color", "COLORTERM": "truecolor", "LANG": env.get("LANG", "C.UTF-8")})
        pid = os.fork()
        if pid == 0:
            try:
                os.setsid()
                os.close(master_fd)
                os.dup2(slave_fd, 0)
                os.dup2(slave_fd, 1)
                os.dup2(slave_fd, 2)
                if slave_fd > 2:
                    os.close(slave_fd)
                os.execve(self.settings.executable, [self.settings.executable, *self.args], env)
            except BaseException:
                os._exit(127)
        os.close(slave_fd)
        self.pid = pid
        os.set_blocking(master_fd, False)
        self.reader_task = asyncio.create_task(self._reader(), name=f"cmatrix-reader-{pid}")
        self.wait_task = asyncio.create_task(self._waiter(), name=f"cmatrix-waiter-{pid}")
        await self.ws.send_json({"type": "started", "program": "cmatrix", "columns": self.columns, "rows": self.rows})

    async def _reader(self) -> None:
        assert self.master_fd is not None
        loop = asyncio.get_running_loop()
        while not self.closed:
            try:
                data = await loop.run_in_executor(None, os.read, self.master_fd, 65536)
            except BlockingIOError:
                await asyncio.sleep(0.01)
                continue
            except OSError:
                break
            if not data:
                break
            self.last_activity = loop.time()
            await self.ws.send_bytes(data)

    async def _waiter(self) -> None:
        assert self.pid is not None
        loop = asyncio.get_running_loop()
        pid, status = await loop.run_in_executor(None, os.waitpid, self.pid, 0)
        code = os.waitstatus_to_exitcode(status)
        if not self.ws.closed:
            await self.ws.send_json({"type": "exit", "code": code, "signal": None if code >= 0 else -code})

    def _resize(self, columns: int, rows: int) -> None:
        self.columns = bounded_int(columns, self.columns, 20, 1000)
        self.rows = bounded_int(rows, self.rows, 10, 500)
        if self.master_fd is not None:
            winsize = struct.pack("HHHH", self.rows, self.columns, 0, 0)
            termios.tcsetwinsize(self.master_fd, (self.rows, self.columns)) if hasattr(termios, "tcsetwinsize") else __import__("fcntl").ioctl(self.master_fd, termios.TIOCSWINSZ, winsize)
            if self.pid:
                try:
                    os.killpg(self.pid, signal.SIGWINCH)
                except ProcessLookupError:
                    pass

    async def handle(self, message: dict[str, Any]) -> None:
        self.last_activity = asyncio.get_running_loop().time()
        kind = str(message.get("type", ""))
        if kind == "start":
            requested = validate_args(message.get("args", self.args))
            if self.pid is None:
                self.args = requested
                await self.start()
        elif kind == "resize":
            self._resize(message.get("columns"), message.get("rows"))
        elif kind == "input":
            data = str(message.get("data", "")).encode("utf-8")
            if len(data) > 4096:
                raise ValueError("input frame too large")
            if self.master_fd is not None:
                os.write(self.master_fd, data)
        elif kind == "signal":
            selected = ALLOWED_SIGNALS.get(str(message.get("signal", "SIGTERM")))
            if selected is None:
                raise ValueError("signal is not allowed")
            if self.pid:
                try:
                    os.killpg(self.pid, selected)
                except ProcessLookupError:
                    pass
        elif kind == "ping":
            await self.ws.send_json({"type": "pong", "timestamp": message.get("timestamp")})
        elif kind == "status":
            await self.ws.send_json({"type": "status", "running": self.pid is not None, "columns": self.columns, "rows": self.rows})
        else:
            raise ValueError(f"unknown message type: {kind}")

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        if self.pid:
            try:
                os.killpg(self.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            await asyncio.sleep(0.1)
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for task in (self.reader_task, self.wait_task):
            if task and not task.done():
                task.cancel()
        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None


async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    settings: Settings = request.app["settings"]
    sessions: set[Session] = request.app["sessions"]
    origin = request.headers.get("Origin", "")
    if settings.allowed_origins and origin not in settings.allowed_origins:
        raise web.HTTPForbidden(text="origin not allowed")
    if len(sessions) >= settings.max_sessions:
        raise web.HTTPServiceUnavailable(text="cmatrix session limit reached")
    columns = bounded_int(request.query.get("columns"), 120, 20, 1000)
    rows = bounded_int(request.query.get("rows"), 40, 10, 500)
    try:
        args = validate_args(json.loads(request.query.get("args", "[]")))
    except (json.JSONDecodeError, ValueError) as error:
        raise web.HTTPBadRequest(text=str(error)) from error
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=64 * 1024, compress=False)
    await ws.prepare(request)
    session = Session(ws, settings, columns, rows, args)
    sessions.add(session)
    await ws.send_json({"type": "ready", "program": "cmatrix", "columns": columns, "rows": rows})
    watchdog = asyncio.create_task(idle_watchdog(session), name="cmatrix-idle-watchdog")
    try:
        async for message in ws:
            if message.type == WSMsgType.TEXT:
                try:
                    payload = json.loads(message.data)
                    if not isinstance(payload, dict):
                        raise ValueError("message must be an object")
                    await session.handle(payload)
                except (json.JSONDecodeError, ValueError) as error:
                    await ws.send_json({"type": "error", "message": str(error)})
            elif message.type in {WSMsgType.ERROR, WSMsgType.CLOSE, WSMsgType.CLOSED}:
                break
    finally:
        watchdog.cancel()
        await session.close()
        sessions.discard(session)
    return ws


async def idle_watchdog(session: Session) -> None:
    loop = asyncio.get_running_loop()
    while not session.closed:
        await asyncio.sleep(10)
        if loop.time() - session.last_activity > session.settings.idle_timeout:
            await session.ws.close(code=4002, message=b"idle timeout")
            return


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"status": "ok", "service": "cmatrix-server"})


def build_app(settings: Settings) -> web.Application:
    app = web.Application(client_max_size=64 * 1024)
    app["settings"] = settings
    app["sessions"] = set()
    app.router.add_get("/healthz", health)
    app.router.add_get("/api/terminal/cmatrix", websocket_handler)
    return app


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Headless PTY server for upstream cmatrix")
    parser.add_argument("--host", default=os.getenv("CMATRIX_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("CMATRIX_PORT", "8765")))
    parser.add_argument("--cmatrix", default=os.getenv("CMATRIX_EXECUTABLE", "cmatrix"))
    parser.add_argument("--idle-timeout", type=int, default=int(os.getenv("CMATRIX_IDLE_TIMEOUT", "900")))
    parser.add_argument("--max-sessions", type=int, default=int(os.getenv("CMATRIX_MAX_SESSIONS", "32")))
    parser.add_argument("--allowed-origin", action="append", default=[])
    parser.add_argument("--log-level", default=os.getenv("CMATRIX_LOG_LEVEL", "INFO"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    executable = shutil.which(args.cmatrix) or (str(Path(args.cmatrix).resolve()) if Path(args.cmatrix).is_file() else None)
    if not executable:
        raise SystemExit("cmatrix executable was not found")
    settings = Settings(
        executable=executable,
        idle_timeout=max(60, args.idle_timeout),
        max_sessions=max(1, args.max_sessions),
        allowed_origins=set(args.allowed_origin or filter(None, os.getenv("CMATRIX_ALLOWED_ORIGINS", "").split(",")))
    )
    LOG.info("using upstream cmatrix executable: %s", executable)
    web.run_app(build_app(settings), host=args.host, port=args.port, access_log=LOG)


if __name__ == "__main__":
    main()
