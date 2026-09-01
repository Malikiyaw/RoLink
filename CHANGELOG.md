# Changelog
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
