# Bridge — Canonical vs Legacy

**Canonical transport (browser execution):** `../bridge.py` (`ws://127.0.0.1:17613`) — sole browser → Studio path. Do not use legacy for browser.

**Legacy alternate bridge:** `legacy/server.py` (aiohttp + websockets + token auth + `POST /queue/enqueue` to `mcp-server :3001`).
Moved to `legacy/` as it is now **deprecated** for browser execution. Retained only for reference / advanced polling fallback.
The `mcp-server` at `:3001` is an *advanced RoLink runtime/tool provider*, not a second browser transport.

If you need the old HTTP queue behavior, run: `python legacy/server.py` (see legacy/README.md), but normal Windows launcher is `../start.bat` → `bridge.py`.
