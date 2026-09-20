# RoLink 2.1.9 — AI → Roblox Studio

**Turn ChatGPT, DeepSeek, Gemini, Kimi, GLM, Qwen, Arena or Meta AI into a Roblox Studio agent.** Browser extension + local bridge + MCP. Download through GitHub, no build needed.

> 🌐 Free alternative for building Roblox games with AI.

Eight providers: **DeepSeek** (recommended), **ChatGPT**, **Gemini**, **Kimi** (`kimi.ai`), **GLM** (`chat.z.ai`), **Qwen** (`chat.qwen.ai`), **Arena** (`arena.ai`), **Meta AI**. Images off on ChatGPT free tier (separate quota); Gemini/Kimi may drop tools in long sessions; Arena keep **Direct** mode (Battle / Side-by-Side unsupported).

## 2.0.0 implementation

113-tool catalog, offline local tools, Luau pre-flight, grouped system-prompt catalog, and full rebrand are included in this release line:

- **113 tools** (`mcp-server/src/tools/registry.ts`, `tests/__registry__.json`): instances, scripting, snapshots, sandbox, terrain/build, UI, animation, datastore, sessions, templates, AI/devops, debug, projects, sound.
- **Works offline**: `get_time`, `validate_command`, `suggest_ordering`, `batch_queue`, and other pure-local tools answer with no Studio connected.
- **Luau pre-flight**: code Studio would certainly reject comes back as a structured validation error the model can fix, instead of a failed Studio call.
- **Live catalog**: `list_commands` always returns all 113 with parameter details, even with Studio closed.

## How it works

```
AI chat (ChatGPT / DeepSeek / Gemini / Kimi / GLM / Qwen / Arena / Meta AI, in your browser)
  -> RoLink Extension -> Bridge (your PC, ws://127.0.0.1:17613) -> Roblox Studio
```

The extension runs inside the chat page. When you type a request, it sends commands to the Bridge running on your PC, which drives Roblox Studio through the built-in MCP server (`StudioMCP`, port `13469`). Extra MCP servers (Blender, Sketchfab, ...) can be attached alongside via `config.json`. `mcp-server/` (Node) is the advanced power layer: queue API, prompts, and tooling around the same catalog.

## Setup

### 1. Download the zip and install the extension

Download the latest zip from the **Releases** page and extract it. The zip contains both the **Bridge** and the **extension folder**.

To load the extension:

- Go to `edge://extensions` (Edge) or `chrome://extensions` (Chrome)
- Enable **Developer mode** (top right toggle)
- Click **Load unpacked**
- Select the `rolink-extension` folder from the extracted zip

### 2. Start Roblox Studio and enable MCP

Open Studio and load a Place, then enable MCP (first time only):

- Click **Assistant AI** in the top bar
- Click **...** (top right of the Assistant panel)
- Click **Manage MCP Servers**
- Click **Enable Studio as MCP Server**

### 2b. Install the RoLink Studio plugin (unlocks all 113 tools)

Roblox's built-in MCP only speaks ~27 commands. The rest of the catalog runs
through our own plugin:

- **Windows:** double-click `install-plugin.bat` inside the extracted folder.
- **macOS:** copy `studio-plugin/RoLink.lua` to `~/Documents/Roblox/Plugins/` (create the folder if missing).
- In Studio, open your place, press **View > Command Bar**, and run:
  `game:GetService("HttpService").HttpEnabled = true` (once per place — lets the plugin reach the bridge).
- Restart Studio if it was open. A **RoLink** toolbar button appears; the bridge prints `plugin polling` when it connects. Without this step, registry tools report a clear `plugin_offline` error instead of running.

### 3. Run the Bridge

- **Windows:** double-click `start.bat` inside the extracted folder.
- **macOS:** double-click `MacOS_Start.command` inside the extracted folder. The first time, macOS shows a security warning — click **Done**, then **System Settings > Privacy & Security > Open Anyway** (once).

A small window opens — the Bridge is running.

### 4. Start a session

Open a new chat on https://chat.deepseek.com (recommended), https://chatgpt.com, https://gemini.google.com, https://www.kimi.ai, https://chat.z.ai, https://chat.qwen.ai, https://arena.ai or https://www.meta.ai. The RoLink bar appears above the input box. Click **Start session** and type what you want to build. The model should call `list_commands` first for the full live reference.

## What the AI can do

- Read and edit scripts, run Luau directly in Studio
- Inspect the game tree, create/move/clone instances, apply materials
- Build terrain, UI, particles, lighting, animations (keyframe tracks)
- Generate assets, levels, quests, sounds; browse the Creator Store
- Control play-testing, debug with breakpoints and watches
- **Remember your project across sessions** (persistent project memory)

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

GPL-3.0-or-later. See `LICENSE`. This 2.0.0 line is a reboot: free-edition foundation with the full 113-tool catalog — one tag, `2.0.0`.
