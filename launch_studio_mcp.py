#!/usr/bin/env python3
"""
RoLink launch_studio_mcp.py — finds newest StudioMCP.exe paired with RobloxStudioBeta.exe
SPDX-License-Identifier: GPL-3.0-or-later
Respects ROLINK_STUDIO_MCP_PATH env override.
"""
import os, sys, pathlib, subprocess, json, time

BRIDGE_VERSION = "1.1.5"

def find_studio_mcp():
    override = os.environ.get("ROLINK_STUDIO_MCP_PATH")
    if override and pathlib.Path(override).exists():
        return override
    candidates = []
    # Windows: LOCALAPPDATA\Roblox\Versions
    for base in [os.environ.get("LOCALAPPDATA"), os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")]:
        if not base: continue
        versions = pathlib.Path(base) / "Roblox" / "Versions"
        if not versions.exists(): continue
        for v in versions.iterdir():
            beta = v / "RobloxStudioBeta.exe"
            mcp = v / "StudioMCP.exe"
            # macOS bundle check inside
            mcp_alt = v / "RobloxStudio.app" / "Contents" / "MacOS" / "StudioMCP"
            found = None
            if mcp.exists(): found = mcp
            elif mcp_alt.exists(): found = mcp_alt
            if found and beta.exists():
                # sort by mtime newest first
                candidates.append((found.stat().st_mtime, str(found)))
    if candidates:
        candidates.sort(reverse=True)
        return candidates[0][1]
    # macOS Applications
    mac_paths = ["/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP", "/Applications/Roblox Studio.app/Contents/MacOS/StudioMCP"]
    for p in mac_paths:
        if pathlib.Path(p).exists():
            return p
    return None

def main():
    mcp = find_studio_mcp()
    if not mcp:
        print("[RoLink] StudioMCP.exe not found. Open Roblox Studio and enable: Assistant AI -> ... -> Manage MCP Servers -> Enable Studio as MCP Server", file=sys.stderr)
        sys.exit(1)
    print(f"[RoLink] launching StudioMCP: {mcp}", file=sys.stderr)
    # Proxy stdio to StudioMCP
    try:
        proc = subprocess.Popen([mcp] if mcp.endswith(".exe") or "/" in mcp else [sys.executable, mcp],
                                stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr)
        proc.wait()
    except KeyboardInterrupt:
        sys.exit(0)
    except Exception as e:
        print(f"[RoLink] launch failed: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()



