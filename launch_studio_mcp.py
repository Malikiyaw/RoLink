#!/usr/bin/env python3
"""
RoLink launch_studio_mcp.py — finds newest StudioMCP.exe paired with RobloxStudioBeta.exe
SPDX-License-Identifier: GPL-3.0-or-later
Respects ROLINK_STUDIO_MCP_PATH env override.
"""
import os, sys, pathlib, subprocess
from pathlib import Path
from typing import Iterable, Optional

ENV_OVERRIDE = "ROLINK_STUDIO_MCP_PATH"
WINDOWS_STUDIO_EXECUTABLES = ("RobloxStudioBeta.exe", "RobloxStudio.exe")
MAC_STUDIO_EXECUTABLES = ("RobloxStudio", "RobloxStudioBeta", "Roblox")

def _candidate_roots():
    roots = []
    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        roots.append(Path(local_appdata) / "Roblox" / "Versions")
    for env in ("ProgramFiles", "ProgramFiles(x86)"):
        value = os.environ.get(env)
        if value:
            roots.append(Path(value) / "Roblox" / "Versions")
    return roots

def _resolve_override_path(path_value):
    path = Path(path_value).expanduser()
    if path.is_file():
        return path
    if path.is_dir():
        if sys.platform == "darwin":
            candidate = path / "Contents" / "MacOS" / "StudioMCP"
        else:
            candidate = path / "StudioMCP.exe"
        if candidate.is_file():
            return candidate
    return None

def _newest_path(paths):
    try:
        return max(paths, key=lambda p: p.stat().st_mtime)
    except (ValueError, OSError):
        return None

def _find_studio_mcp_windows():
    paired, orphans = [], []
    for root in _candidate_roots():
        if not root.is_dir():
            continue
        try:
            for version_dir in root.iterdir():
                if not version_dir.is_dir():
                    continue
                studio_mcp = version_dir / "StudioMCP.exe"
                if not studio_mcp.is_file():
                    continue
                if any((version_dir / exe_name).is_file() for exe_name in WINDOWS_STUDIO_EXECUTABLES):
                    paired.append(studio_mcp)
                else:
                    orphans.append(studio_mcp)
        except OSError:
            continue
    return _newest_path(paired) or _newest_path(orphans)

def _mac_app_candidates():
    home = Path.home()
    return [
        Path("/Applications/RobloxStudio.app"),
        home / "Applications" / "RobloxStudio.app",
        Path("/Applications/Roblox.app"),
        home / "Applications" / "Roblox.app",
        Path("/Applications/RobloxStudioBeta.app"),
        home / "Applications" / "RobloxStudioBeta.app",
    ]

def _find_studio_mcp_mac():
    for app in _mac_app_candidates():
        macos_dir = app / "Contents" / "MacOS"
        studio_mcp = macos_dir / "StudioMCP"
        if not studio_mcp.is_file():
            continue
        if any((macos_dir / exe_name).is_file() for exe_name in MAC_STUDIO_EXECUTABLES):
            return studio_mcp
    return None

def find_studio_mcp():
    override_value = os.environ.get(ENV_OVERRIDE)
    if override_value:
        override_path = _resolve_override_path(override_value)
        if override_path:
            return override_path
        sys.stderr.write(
            f"launch_studio_mcp: {ENV_OVERRIDE} is set but does not point to a valid StudioMCP binary: {override_value}\n"
        )
    if sys.platform == "darwin":
        return _find_studio_mcp_mac()
    return _find_studio_mcp_windows()

def main():
    exe = find_studio_mcp()
    binary_name = "StudioMCP" if sys.platform == "darwin" else "StudioMCP.exe"
    if not exe:
        sys.stderr.write(
            f"launch_studio_mcp: no {binary_name} found. Open Roblox Studio and "
            "enable 'Studio as MCP server' (Assistant Settings > MCP Servers).\n"
        )
        return 1
    sys.stderr.write(f"launch_studio_mcp: using {exe}\n")
    sys.stderr.flush()
    proc = subprocess.Popen([str(exe)] + sys.argv[1:])
    try:
        return proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        return proc.wait()

if __name__ == "__main__":
    sys.exit(main())
