# Changelog
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
