# Changelog
## 1.1.5 - ZeroScript-style bridge + Python 3.14 fix + simple extension
- **bridge.py crash fix on Python 3.14:** the `serve(..., process_request=..., sock=_sock)` combo failed silently (the legacy `from websockets.server import serve` import + own-bound `sock` is the deprecated code path). Switched to the new `from websockets.asyncio.server import serve` import with `serve(..., process_request=...)` only. start.bat reclaims the port, so SO_REUSEADDR is no longer needed.
- **ZeroScript-style bridge:** the bridge now auto-spawns `launch_studio_mcp.py` as the only MCP server (no Node mcp-server / no `npm run build` needed). A new `config.json` ships with `{"mcpServers":{"roblox":{"command":"launch_studio_mcp.py","args":[]}}}` so the bridge talks to Roblox Studio out of the box.
- **ZeroScript-style WS protocol in bridge.py:** new message types `list_tools`, `call_tool` (with `server/tool` routing), `restart_mcp`, `add_server`/`remove_server` (auto-write config.json), `studio_status` (tasklist-based Roblox Studio app probe), `ping` → `pong`. Backward-compatible with the legacy method-style frames.
- **start.bat simplified** (matches your reference): just `[1/3] Python` → `[2/3] websockets` → `[3/3] bridge`, no Node, no MCP server, no port-17613 race.
- **Popup redesigned to ZeroScript style:** small (248px), dark theme, status dot, tools count, tools list (collapsible), activity log, "▶ Start agent" (full-width blue) + Reconnect / Restart Roblox server / Settings buttons. No more 5-button grid; just what the AI needs.
- **background.js rewritten** to ZeroScript's protocol: `status`, `list_tools`, `call_tool`, `restart_mcp`, `add_server`, `remove_server`, `reconnect`, `version` messages. Proper async sendResponse with `waitForConnection` for SW wake-up.
- **Removed:** the `mcp-server/` Node dependency from the runtime path (still in repo for power users, but no longer required). The popup no longer shows "MCP server not built" - everything is Python.
- Sync 1.1.5 across all versioned files.
- **Extension popup:**
  - New **"▶ Start agent"** button (full-width, gradient blue). It finds the active AI tab (DeepSeek, ChatGPT, Gemini, Kimi, GLM, Qwen, Arena, Meta) and injects the system prompt + a starter question, then auto-clicks Send.
  - **Tools section** shows the live tool list pulled from `bridge.py`'s new `/tools` HTTP endpoint, with a count pill and styled tool tags. Now you can see every tool the AI has access to.
  - **Activity log** shows real-time events: agent start, tool invocations, errors, with timestamps. Tool invocations in the AI tab also push to the log via `chrome.runtime.sendMessage({type:"log"})`.
- **New content script** `core/inject.js`: finds the page's chat input (works on DeepSeek, ChatGPT, Gemini, Kimi, GLM, Qwen, Arena, Meta), sets the value via React-friendly setter (for textarea) or `execCommand("insertText")` (for contenteditable), then submits.
- **System prompt in `core/config.js`** rewritten to clearly show the `###MCP_TOOL###` JSON format and the full tool list (create_instance, run_code, get_snapshot, set_property, get_logs, undo, heal_code, rollback, perf_stats, translate_code, validate_code, run_sandbox_tests, plan, get_context, list_templates, use_template, style_profile, generate_tests, git_commit, review_code, compile_visual, collab_broadcast, search_assets, import_asset, report_metrics, generate_gdd, generate_asset, optimize_perf, analytics_report, analytics_suggestions).
- **`bridge.py`:** new `/tools` HTTP endpoint that proxies to the Node MCP server's `/tools` (or returns a fallback tool list if the MCP server isn't running).
- **`start.bat` simplified** (matches your reference style): `[1/3]` Python, `[2/3]` websockets, `[3/3]` bridge, with an optional Node `mcp-server` background launch (skips gracefully if Node or the build is missing).
- **Overlay bar** "Start session" → "▶ Start agent" (triggers the same injection), gradient tool chip.
- Sync 1.1.4 across all versioned files.
- `bridge.py`: drop the redundant `host`/`port` args from `serve(...)` when passing a pre-bound `sock` (Python 3.14 asyncio rejects the combination with `ValueError: host/port and sock can not be specified at the same time`).
- `start.bat`: remove embedded quotes from `set "PY=%%~R\%%D\python.exe"` in the pre-install scan (was producing `""` when later expanded as `"%PY%"` → `'-m' is not recognized`).
- **UI overhaul (1000x better than ZeroScript):**
  - **Popup:** modern dark theme with live status dot (green/yellow/red/grey + glow), live bridge clients / MCP servers / uptime readouts, 5 buttons: Reconnect, Restart, Studio, Settings, Copy log path.
  - **Options page:** redesigned with sections (Endpoints, Keyboard shortcuts, About), focus-glow inputs, version badge, Enter-to-save, Reset-to-defaults button.
  - **In-page overlay:** gradient bar with animated glowing dot, Settings ⚙ button, Start-session turns into ✓ Active.
  - **Keyboard shortcut:** `Ctrl+Shift+R` opens the popup (Chrome command `open-popup`, rebindable in `chrome://extensions/shortcuts`).
  - **Background:** exposes `version` and `reconnect` messages to the popup; reads version from `chrome.runtime.getManifest()` so it can never drift.
- Sync 1.1.3 across all versioned files.
- `start.bat`: every `call %PY%` is now `call "%PY%"` (the path contains spaces, e.g. `C:\Users\Administrator\AppData\Local\Programs\Python\RoLinkPython312\python.exe`; without quotes, cmd split on spaces and `-m` became a separate "command").
- `start.bat`: use **three separate PS1 files** (`rolink-dl.ps1`, `rolink-extract.ps1`, `rolink-patch.ps1`) instead of reusing one — the single-file reuse was fragile (the `_pth` patch PS1 could see content from a prior call depending on write order, which caused the `Cannot find drive 'https'` error).
- `start.bat` patch script now `Test-Path $p` first and exits cleanly if the file is missing instead of calling `Get-Content` on a bad value.
- `bridge.py`: bind the listening socket ourselves with `SO_REUSEADDR` so a respawn after a crash can rebind `127.0.0.1:17613` immediately (was holding the port in TIME_WAIT).
- `core/main.js`: remove the `add_server` call that was spawning a **second** `bridge.py` on `Start session` — that second bridge tried to bind 17613 too, hit `OSError 10048`, crashed, and the bridge kept respawning it. The single bridge is the bridge; nothing to add.
- Sync 1.1.2 across all versioned files.

## 1.1.1 - Use -File + temp .ps1 for PowerShell download (no more $args loss)
- `start.bat` `:direct_dl`: switch all PowerShell invocations from `-Command "..." arg1 arg2` to `-File script.ps1 arg1 arg2`. The `-Command` + trailing args form is fragile: depending on PowerShell version the args may not land in `$args[]` (which is why `Invoke-WebRequest -Uri $args[0]` saw an empty Uri).
- New approach: write the PS script to `%TEMP%\rolink-download.ps1` via `>` / `>>` redirect, then `powershell -NoProfile -ExecutionPolicy Bypass -File "%DL_PS1%" url out`. `$args[0]` / `$args[1]` are then reliably populated.
- Hardcoded `%TEMP%` and `%LOCALAPPDATA%` fallbacks (`%SystemRoot%\Temp`, `%USERPROFILE%\AppData\Local`) so the script never breaks on sessions where those env vars are missing.
- URLs stored in `URL_PY` / `URL_PIP` (no env-var indirection).
- Sync 1.1.1 across all versioned files.

## 1.1.0 - Fix embedded-quote bug in start.bat direct-download fallback
- `start.bat` `:direct_dl`: `set "PY=\"%PYDIR%\python.exe\""` was the bug — cmd's quote-stripping turned the value into literal `\"...\""`, which then broke every later `call %PY%` invocation (path lost its drive letter, e.g. `'\python.exe\"'`).
- Variables now hold RAW paths/URLs (no embedded quotes); call sites use `call "%PYEXE%" --version`. The download URLs and the python.exe path are stored in separate variables (`PYEXE`, `PYURL`, `PYZIP`, `GETPIP`, `GETPIPURL`, `PYDIR`).
- Diagnostic block on `validate_py` failure now prints `PYEXE=...` once, then `call "%PYEXE%" --version` and `call "%PYEXE%" -m pip --version` with proper quoting.
- All `:log` lines now include the offending var values so future failures are self-diagnosing.
- Sync 1.1.0 across all versioned files.

## 1.0.9 - Fix embeddable-Python direct-download fallback
- `start.bat` direct-download fallback: pass URLs/paths to PowerShell as **arguments** (`$args[N]`) instead of via `%VAR%` inside the `-Command` string, so paths with spaces or special chars can never mangle the command.
- Validate the extracted `python.exe` exists *before* calling validate (clearer error if Expand-Archive silently dropped nothing).
- `python312._pth` patch now also uncomments any `#python.exe -s` line that strips the path.
- On `validate_py` failure, dump `python --version` and `pip --version` output to the console so the failure mode is obvious (no more silent "Embeddable Python did not validate" with no detail).
- Sync 1.0.9 across all versioned files.

## 1.0.8 - Auto-install Python via direct download when winget is broken
- `start.bat` now falls back to downloading the official Python 3.12 embeddable zip from python.org when winget is missing OR when winget fails with errors like `0x8a15000f : Data required by the source is missing` (common on corporate / locked-down Windows where the winget source DB is broken or restricted).
- The embeddable zip is self-contained, no admin / no MSI, extracts to `%LOCALAPPDATA%\Programs\Python\RoLinkPython312`. Patches `python312._pth` to enable `site-packages` and bootstraps `pip` from `bootstrap.pypa.io/get-pip.py` so `pip install websockets` still works.
- Sync version 1.0.8 across `VERSION`, `bridge.py`, `launch_studio_mcp.py`, `manifest.json`, `core/config.js`, `popup.html`, `mcp-server/package.json`.

## 1.0.7 - start.bat vanish fix (ZeroScript-style rewrite)
- Rewrite `start.bat` to match ZeroScript's vanishing-free structure: `call %PY%` everywhere (handles `py -3` two-token + quoted full path), `!OLDPID!`/`!STILLTHERE!` delayed-expansion in the port-reclaim block, single bottom-of-script `pause >nul` + `exit /b 0`, and `:log` sub using redirect-first `>>"%LOGFILE%" 2>nul echo(`.
- Replace `->` with ASCII `^>` / `-` to avoid chcp 65001 race.
- Add clearer Python-not-found / winget-missing error paths and an `rolink-extension` missing-guard.
- Sync version 1.0.7 across `VERSION`, `bridge.py`, `launch_studio_mcp.py`, `manifest.json`, `core/config.js`, `popup.html`, `mcp-server/package.json`.

## 1.0.6 - CSP fix + start.bat vanish fix
- Extract inline `<script>` from `rolink-extension/options.html:8` into external `rolink-extension/options.js` to fix MV3 inline-script block under default CSP `script-src 'self'`.
- Rewrite `start.bat` (own code, SPDX header only): remove `cmd /c` relaunch guard (was causing window vanish), normalize `->` (no Unicode arrow), keep window open on exit via `pause >nul`, validate Python with `where py` then `%LOCALAPPDATA%\Programs\Python` scan, guard `winget` via `where winget`, reclaim :17613 with `taskkill /F /T` + `timeout /t 1 /nobreak`, log everything to `logs/start.log` via `:log` sub.
- Remove `start.ps1` fallback (no longer needed; `.bat` is single launcher on Windows).
- Sync version 1.0.6 across `VERSION`, `bridge.py`, `launch_studio_mcp.py`, `manifest.json`, `core/config.js`, `popup.html`, `mcp-server/package.json`.

## 1.0.5 - SPDX GPL-3.0 headers
- Add `SPDX-License-Identifier: GPL-3.0-or-later` to `start.bat`, `MacOS_Start.command`, `bridge.py`, `launch_studio_mcp.py` and update `LICENSE` to GPL-3.0 (no body text copy).

## 1.0.4 - Fix start.bat /d parsing + PowerShell fallback
- Fix `'/d' is not recognized` when `.bat` opened via bash/PowerShell: keep `chcp 65001`, add auto-detect `COMSPEC` and relaunch via `cmd /c`, use absolute `%~dp0` paths for `bridge.py` and `logs`, keep Unicode. Add `start.ps1` fallback (`powershell -ExecutionPolicy Bypass -File start.ps1`).

## 1.0.3 - Fix popup options page (Could not create an options page)
- Add `rolink-extension/options.html` + `manifest options_ui` + safe `chrome.runtime.openOptionsPage` fallback to fix `Uncaught (in promise) Could not create an options page` in popup.html.

## 1.0.2 - Fix WS ERR_CONNECTION_REFUSED (health probe + badge, bridge HTTP health)
- Bridge offline now shows `!` badge after 30s and throttled `healthProbe` (`http://127.0.0.1:17613/health`) before WS to avoid `ERR_CONNECTION_REFUSED` spam; `bridge.py` now serves `/health` via `process_request` on same port.

## 1.0.1 - Fix background.js broadcast (Receiving end does not exist)
- Fix `Uncaught (in promise) Could not establish connection` by scoping broadcast to 8 provider URLs and swallowing Promise rejections (MV3 `chrome.tabs.sendMessage(...).catch`).

## 1.0.0 - Initial Release
- GitHub Download: Releases ZIP workflow, `start.bat`/`MacOS_Start.command` dual launchers (Python cascade, logs/start.log, :17613 reclaim), `bridge.py` hardened WS + MCPClient + StudioMCP finder, `launch_studio_mcp.py`, `rolink-extension/` zero-build with 8 providers (deepseek, chatgpt, gemini, kimi, glm, qwen, arena, meta) — Load unpacked, no build needed.
- Power: `mcp-server` S1-S48 (38+ tools) as optional advanced — bridge HTTP fallback to http://127.0.0.1:3001.
- MIT license, 5-step setup, panel dots green/yellow/grey. Fix manifest error by selecting rolink-extension folder.

## 0.3.0 - Phase C
- S11 visualCompiler, S14 collab, S15 assetStore, S16 gameplayFeedback, S19 GDD, S21 assetGen, S22 perfOptLoop, S23 analytics + build fix (Node 24, tsconfig rootDir ..)

## 0.2.0 - Phase B
- S1-S9 core + S10/S12/S17/S20 + tsc build OK

## 0.1.0 - Phase A
- Foundation bridge(17613)+mcp(3001)+extension MV3+studio plugin poll 200ms
