# RoLink Workflow Contract (ZeroScript parity, Option A)

Single transport, no forks:

```
AI chat DOM
  -> rolink-extension (providers/*.js + core/parser.js + core/main.js + core/execution.js)
  -> background.js (sole ws://127.0.0.1:17613 owner, always-resolves contract)
  -> bridge.py safe_call/handle_call_tool
    -> LOCAL_HANDLERS (pure-local, works offline) OR
    -> batch_queue fan-out (sequential safe_call recursion, max 20) OR
    -> MCPManager.call -> StudioMCP.exe stdio (port 13469 probe) -> Roblox Studio
```

## Routing rules (bridge.py)

- `LOCAL_HANDLERS`: `get_time, validate_command (+Luau pre-flight on args.code),
  suggest_ordering, get_suggestions,
  list_plugins, get_projects, switch_project (offline, in-memory active),
  get_memory_usage, set_performance_threshold,
  list_sessions, session_users` — deterministic, no Studio probe, no `any_alive` gate.
- `batch_queue`: validated `{commands:[{tool,args}]}` then sequential `safe_call`
  recursion. Nested batches rejected. Each sub-result recorded `{index,tool,ok,...}`.
- Everything else: `any_alive` check, then `NEEDS_STUDIO` probe
  (`STUDIO_ROUTED_TOOLS` + `get_studio_state/list_roblox_studios/take_snapshot/...`),
  then `mgr.call`. Unknown tool -> `RuntimeError("unknown tool")` ->
  `validation_error` with AI-readable hint. Never raises, never hangs.
- Validation order: name non-empty string <=120 chars -> args must be object
  (`None` => `{}`) -> `ROLINK_DEBUG_DISPATCH=1` log -> local fast-path -> alive/probe.
- `list_tools`: live StudioMCP tools + missing `ROLINK_TOOL_NAMES` (from
  `tests/__registry__.json`, 111) as `server:local` so the prompt always lists 111.

## Frame contract (shared/protocol.ts + background.js + execution.js)

- `call_tool {type,id,name,arguments,timeout,sessionId,turnId}` (120s default,
  20s for `execute_luau`, +10s extension margin, 130s bridge timeout).
- `tool_result {type,id,ok,kind,text,error,images}`. `kind` in
  `success|validation_error|bridge_offline|mcp_offline|studio_offline|timeout|
  execution_error|cancelled|stale-extension`.
- Every `sendMessage` resolves. `studio_status`, `connected`, `pong`, `tools`,
  `mcp_status`, `server_changed` handled. Stale tab pauses execution.

## Parser contract (core/parser.js)

- Canonical `{tool,args}` + aliases `{name,arguments}` (same reference).
- Accepts `###MCP_TOOL###{tool,args|arguments|params}`, `###LUA###` (+`:Edit|Client|Server`,
  `-`/`_` variants), `###TOOL:name###` + `###RAW:field###` blocks, ````json fences.
- `cleanLuaCall` idempotent, `stripCodeChrome` (`Copy `/`json `), string-aware
  `matchBrace`/`scanBalancedObject`, `salvageCutOff` max 2 closers never mid-string.
- `normalize` returns null on ambiguous input (never execute guesses). All
  rejections flow back to the model via `feedToolResultTransactional`.
