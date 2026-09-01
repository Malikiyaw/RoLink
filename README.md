# RoLink — AI → Roblox Studio (More Powerful than ZeroScript)

**Turn ChatGPT, DeepSeek, Gemini, Kimi, GLM, Qwen, Arena or Meta AI into a Roblox Studio agent.** Browser extension + local bridge + MCP. Download through GitHub, no build needed — more powerful than ZeroScript-Free with S1–S48 power tools.

> 🌐 Free Lemonade.gg / Luamotion alternative for building Roblox games with AI.

Eight providers: **DeepSeek** (recommended), **ChatGPT**, **Gemini**, **Kimi** (`kimi.ai`), **GLM** (`chat.z.ai`), **Qwen** (`chat.qwen.ai`), **Arena** (`arena.ai` Direct mode), **Meta AI**. Images off on ChatGPT free tier (separate quota); Gemini/Kimi may drop tools in long sessions; Arena keep **Direct** mode.

```
AI chat (in browser) -> RoLink Extension -> Bridge (127.0.0.1:17613) -> Roblox Studio (StudioMCP.exe) [+ optional mcp-server 3001 for S1-S48 power]
```

## What the AI can do (beyond ZeroScript)
- Read/edit scripts, run Luau (sandboxed, self-heals), inspect tree, generate meshes/materials, Creator Store browse, play-test control, **persistent project memory**
- **Power:** self-healing (S1), rollback (S2), perf tracking (S3), multi-engine translate (S4), sandbox tests (S5), planning/GDD (S6/S19), team log (S7), context injection (S8), templates (S9), AI training on your codebase (S10), visual scripting → Luau (S11), test gen (S12), collab sessions (S14), asset store (S15), gameplay feedback (S16), git commit (S17), bug predict (S18), code review (S20), asset gen (S21), perf opt loop (S22), analytics (S23), DDA (S45), sound design (S48), etc. See `mcp-server/src/` (38 tools on `http://127.0.0.1:3001/tools`).

## Setup (GitHub Download — No Rojo, No Build)

> 📺 See ZeroScript tutorial https://youtu.be/kPKiZLZ9_Ps for same steps (replace `zeroscript-extension` with `rolink-extension`).

### 1. Download the zip and install extension
Download latest zip from **Releases** (or `git clone https://github.com/Malikiyaw/RoLink` and zip it). Extract.

- `edge://extensions` or `chrome://extensions` → **Developer mode** ON → **Load unpacked** → select `rolink-extension` folder (prebuilt, no `npm`). Also `extension/` works legacy.

### 2. Start Roblox Studio and enable MCP
Open a Place → **Assistant AI** (top bar) → **…** → **Manage MCP Servers** → **Enable Studio as MCP Server** (first time only).

### 3. Run the Bridge
- **Windows:** double-click `start.bat` (auto-finds `py -3` → `python` → scans `LOCALAPPDATA\Programs\Python` → `winget install Python.Python.3.12` if missing, installs `websockets`, reclaims `:17613`, logs to `logs/start.log`, keeps window open).
- **macOS:** double-click `MacOS_Start.command` (bypasses Gatekeeper: System Settings → Privacy & Security → Open Anyway once).

A small window opens = bridge running `ws://127.0.0.1:17613` (StudioMCP via `launch_studio_mcp.py` + HTTP fallback to `mcp-server`).

### 4. Start a session
Go to `chat.deepseek.com` (recommended), `chatgpt.com`, `gemini.google.com`, `kimi.ai`, `chat.z.ai`, `chat.qwen.ai`, `arena.ai` (Direct) or `meta.ai` → new chat → RoLink bar appears above input → **Start session** → type what to build.

> Only works on those 8 domains; Arena Direct only; Gemini/Kimi may need “use the commands” reminder.

### 5. (Optional) Advanced Power — mcp-server
For S1–S48 beyond ZeroScript core:
```powershell
& "C:\Program Files\nodejs\npm.cmd" -C mcp-server install
& "C:\Program Files\nodejs\npm.cmd" -C mcp-server run build
& "C:\Program Files\nodejs\node.exe" mcp-server/dist/mcp-server/src/index.js
# then add to config.json: { "mcpServers": { "rolink-advanced": {"command":"node","args":["mcp-server/dist/mcp-server/src/index.js"]} } }
# Bridge HTTP fallback already proxies to http://127.0.0.1:3001
```

## Panel status
| Dot | Meaning |
|-----|---------|
| Green | Bridge + Studio ready (place open) |
| Yellow | Bridge OK, Studio not usable — open place / enable MCP |
| Grey | Bridge offline — run `start.bat` / `MacOS_Start.command` |

## Requirements
- Windows or macOS, Roblox Studio (MCP built-in), Edge/Chrome, Python 3.9+ (auto-installed on Windows)

## Files in ZIP (Releases)
`bridge.py` (hardened WS + MCPClient), `config.json`, `launch_studio_mcp.py` (finds newest StudioMCP.exe), `start.bat`, `MacOS_Start.command`, `rolink-extension/` (zero-build), `mcp-server/` (optional power), `studio-plugin/` (legacy 200ms poll fallback), `logs/`.

## Support
MIT — attribution to ZeroScript-Free launcher patterns kept in comments.
