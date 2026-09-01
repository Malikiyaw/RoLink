# RoLink Versioning (SemVer)

- **1.0.0** — initial release
- **2.0.0** — big feature / breaking change (new MCP tools, bridge protocol change, major UI)
- **1.1.0** — bug fix or minor feature (new provider, asset gen tweak, launcher fix)
- **1.1.1** — little change (typo, docs, small patch)

All of `rolink-extension/manifest.json` version, `bridge.py` BRIDGE_VERSION, `launch_studio_mcp.py`, `mcp-server/package.json`, and `core/config.js` ROLINK_VERSION must stay in sync. Tag releases as `v1.0.0` etc.; `.github/workflows/release.yml` creates `RoLink-v1.0.0.zip`.
