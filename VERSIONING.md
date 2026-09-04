# RoLink Versioning (SemVer)

- **5.4.1** — Sprint 4 Heal+Prove patch: feed nudge styling, trace pipeline stages, stall watchdog, hidden diag JSON node, import session-ID guard, bridge ZS_BRIDGE_PORT alias, validate_command Luau pre-flight, offline switch_project, start.bat version+port override
- **5.4.0** — background run, narration guard, two-row result chips, all 111 master prompts
- **4.2.0** — parser hardening, raw-field execution format, generated 111-tool fixtures/audit, provider-specific adapters, multi-MCP settings UI, release automation
- **1.x–3.x** — historical releases

The extension manifest, MCP package, parser/system-prompt version, bridge runtime version and release metadata should move together. Releases use `vMAJOR.MINOR.PATCH`; the tag workflow reads `VERSION` and creates the matching Git tag.
