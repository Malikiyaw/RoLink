# Deprecated — bridge legacy server

This folder contains the pre-3.0 alternate bridge (`server.py` + `auth.py`) which used `aiohttp` and forwarded to `mcp-server` via HTTP `/queue/enqueue`.

It is superseded by canonical `bridge.py` (`ws://127.0.0.1:17613` ↔ StudioMCP `13469`).

- Do not use for normal browser execution.
- `mcp-server` is now an advanced tool provider, not a competing transport.
- Kept for reference; will be removed in a future major version.
