# RoLink — AI → Roblox Studio Bridge

Open-source tool that lets AI chat (DeepSeek, ChatGPT, Claude, etc.) directly control Roblox Studio via MCP.

## Architecture (4 layers)
1. **Browser extension (Chrome MV3)** — intercepts AI chat responses, sends commands to bridge.
2. **Local bridge (Python)** — WebSocket server on `ws://127.0.0.1:17613`, forwards to MCP.
3. **MCP server (Node.js/TS)** — HTTP on `http://127.0.0.1:3001`, command queue, static analysis, planning, etc.
4. **Studio plugin (Luau)** — polls MCP every 200ms (or WebSocket), executes, snapshots, heals, reports timings.

## Quick Start (Phase A)
```powershell
# 1. Bridge
pip install websockets aiohttp
python bridge/server.py

# 2. MCP server
cd mcp-server; npm install; npm run dev

# 3. Extension
# chrome://extensions -> Developer mode -> Load unpacked -> extension/
# 4. Studio plugin
# Rojo: rojo serve  or copy studio-plugin/src to Roblox Studio Plugins folder
```

## Ports
- Bridge WS: `17613` (`/ws?role=extension|plugin&token=...` + `/health`)
- MCP HTTP: `3001` (`/health`, `/queue/enqueue`, `/queue/next`, `/queue/result`, `/queue/status`)

## Security
- Bind `127.0.0.1` only, token `hmac.compare_digest`, Origin/Host validation
- Allowlist tools, no arbitrary shell
- Redaction in extension before storage

## Project Structure
See `shared/protocol.ts` for wire contract v1.
