# Speciedex Terminal API Backend

This package supplies the missing headless backend for the browser terminal.

It supports two deployment modes:

1. A live Python HTTP service at `/api/speciedex/v1/`.
2. GitHub Pages-compatible static JSON artifacts generated under `api/speciedex/v1/`.

## Commands

```bash
python static/tools/terminal-api.py --check
python static/tools/terminal-api.py --generate-static
python static/tools/terminal-api.py --host 127.0.0.1 --port 8765
python static/tools/terminal-api-cli.py check
python static/tools/terminal-api-cli.py build-static
python static/tools/terminal-api-cli.py call health
```

## Live endpoints

```text
GET  /api/speciedex/v1/
GET  /api/speciedex/v1/health
GET  /api/speciedex/v1/stats
GET  /api/speciedex/v1/providers
GET  /api/speciedex/v1/routes
GET  /api/speciedex/v1/search?q=...
POST /api/speciedex/v1/search
GET  /api/speciedex/v1/manifests
GET  /api/speciedex/v1/checksums
GET  /api/speciedex/v1/benchmark
GET  /api/speciedex/v1/stream
```

## GitHub Pages behavior

GitHub Pages does not execute Python. The included workflow runs the Python builder in Actions and commits generated JSON files to:

```text
api/speciedex/v1/
```

The browser client can read those static artifacts directly. Live search and SSE require the daemon or another server-side deployment.

## Frontend configuration

The repaired `terminal-api.js` defaults to:

```text
/api/speciedex/v1/
```

For the live daemon, reverse-proxy that path to port `8765`. For Pages, keep the generated `api/speciedex/v1/` directory in the repository.
