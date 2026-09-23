# RoLink 2.4.0 — AI → Roblox Studio

**Turn ChatGPT, DeepSeek, Gemini, Kimi, GLM, Qwen, Arena, Arena Agent, Meta AI, Claude, HF Chat, or Dola into a Roblox Studio agent.** Browser extension + local bridge + MCP. Download through GitHub, no build needed.

> 🌐 Free alternative for building Roblox games with AI.

Twelve providers: **DeepSeek** (recommended), **ChatGPT**, **Gemini**, **Kimi** (`kimi.ai`), **GLM** (`chat.z.ai`), **Qwen** (`chat.qwen.ai`), **Arena** (`arena.ai`, Direct mode), **Arena Agent** (`arena.ai/agent`, supervised), **Meta AI**, **Claude** (`claude.ai`), **HF Chat** (`huggingface.co/chat`, fresh support, login required), **Dola** (`dola.com`, fresh support, text-only). Pi (`pi.ai`) is unsupported — its abuse filters escalate to account bans; do not use RoLink there. Images off on ChatGPT free tier (separate quota); Gemini/Kimi may drop tools in long sessions; Arena chat keep **Direct** mode (Battle / Side-by-Side unsupported); Agent Mode runs supervised — it reads settled output, pauses at human prompts, and never votes for you.

## New in 2.4.0

See [CHANGELOG.md](CHANGELOG.md): execution-truth envelopes on every tool, `execute_luau` preflight + atomic batches, tools 120–124, Studio truth + project memory, HF Chat and Dola providers, proof-gated session start, account-restriction handling, and hardened Dola/HF reads.

## How it works

```
AI chat (in your browser)
  -> RoLink Extension -> Bridge (your PC, ws://127.0.0.1:17613) -> Roblox Studio
```

The extension runs inside the chat page. When you type a request, it sends commands to the Bridge running on your PC, which drives Roblox Studio through the built-in MCP server (`StudioMCP`, port `13469`). Extra MCP servers (Blender, Sketchfab, ...) can be attached alongside via `config.json`. `mcp-server/` (Node) is the advanced power layer: queue API, prompts, and tooling around the same catalog.

## Setup (everything, in order)

### 1. Download the zip and install the extension

Download the latest zip from the **Releases** page and extract it. The zip contains both the **Bridge** and the **extension folder**.

To load the extension:

- Go to `edge://extensions` (Edge) or `chrome://extensions` (Chrome)
- Enable **Developer mode** (top right toggle)
- Click **Load unpacked**
- Select the `rolink-extension` folder from the extracted zip
- After any update: press the extension's **reload icon** on `chrome://extensions`, then refresh your AI tabs (a page refresh alone does not load new files)

### 2. Start Roblox Studio and enable MCP

Open Studio and load a Place, then enable MCP (first time only):

- Click **Assistant AI** in the top bar
- Click **...** (top right of the Assistant panel)
- Click **Manage MCP Servers**
- Click **Enable Studio as MCP Server**

### 2b. Install the RoLink Studio plugin (unlocks all 124 tools)

Roblox's built-in MCP only speaks ~27 commands. The rest of the catalog runs
through our own plugin:

- **Windows:** double-click `install-plugin.bat` inside the extracted folder.
- **macOS:** copy `studio-plugin/RoLink.lua` to `~/Documents/Roblox/Plugins/` (create the folder if missing).
- In Studio, open your place, press **View > Command Bar**, and run:
  `game:GetService("HttpService").HttpEnabled = true` (once per place — lets the plugin reach the bridge).
- **Quit Studio completely first** — it caches plugins at startup, so installing while open changes nothing until a full restart. A **RoLink** toolbar button appears; the bridge prints `plugin polling` when it connects. Without this step, registry tools report a clear `plugin_offline` error instead of running.
- After every RoLink update, reinstall the plugin the same way (quit Studio → run installer → reopen).

### 3. Run the Bridge

- **Windows:** double-click `start.bat` **inside the extracted folder for this version** (an old folder runs the old bridge — check the banner version below).
- **macOS:** double-click `MacOS_Start.command` inside the extracted folder. The first time, macOS shows a security warning — click **Done**, then **System Settings > Privacy & Security > Open Anyway** (once).

A small window opens — the Bridge is running.

### 4. Start a session

Open a new chat on https://chat.deepseek.com (recommended), https://chatgpt.com, https://gemini.google.com, https://www.kimi.ai, https://chat.z.ai, https://chat.qwen.ai, https://arena.ai, https://arena.ai/agent, https://www.meta.ai, https://claude.ai, https://huggingface.co/chat, or https://dola.com. The RoLink bar appears above the input box. Click **Start session** and type what you want to build. The model should call `list_commands` first for the full live reference.

## Version check (all four must match)

| Where | What to look for |
| --- | --- |
| Bridge terminal banner | `BRIDGE START v2.4.0` (proves which folder you launched) |
| Bridge `plugin vX` line | Must equal the bridge version — a mismatch means Studio loaded a stale plugin; redo step 2b with Studio fully quit |
| Extension bar/popup | `v2.4.0` next to the RoLink name |
| Studio Output on launch | `RoLink 2.4.0 loaded` |

If any one differs, that component came from a different install — reinstall it from this release.

## What the AI can do

- Read and edit scripts, run Luau directly in Studio
- Inspect the game tree, create/move/clone instances, apply materials
- Build terrain, UI, particles, lighting, animations (keyframe tracks — easing names need their suffix: `quadIn`, not bare `quad`; max 1024 poses per track)
- Generate assets, levels, quests, sounds; browse the Creator Store
- Control play-testing, debug with breakpoints and watches
- Scan Output errors, inspect UI rects, map the viewport schematically
- Verify gameplay with scenario playtests, migrate systems atomically
- **Remember your project across sessions** (structured project memory: architecture, services, bugs, decisions)

## Panel status

| Dot | Meaning |
| --- | --- |
| Green | Bridge + Studio ready (a place is open) |
| Yellow | Bridge OK, but Studio isn't usable yet — open Roblox Studio, load a place, or enable its MCP server |
| Grey | Bridge offline — run start.bat (Windows) or MacOS_Start.command (macOS) |

## Requirements

- Windows or macOS
- Roblox Studio (MCP support built-in)
- Microsoft Edge or Chrome
- Python 3.9+ (auto-installed on Windows; install from python.org on macOS)
- Node 18+ only if you run `mcp-server/` directly (optional)

## Multi-MCP servers

`config.json` declares every MCP server (default: `roblox`). Add more (Blender, etc.) from the extension popup or by editing the file — the Bridge restarts itself to reload. The `roblox` entry is the primary server and can't be removed.

## License

GPL-3.0-or-later. See `LICENSE`.
