# Changelog
## 4.0.1 - Free-chat greeting per start + bar polish (patch)
Fixes screenshot issues: delete `Don't ask ACT` auto-nudge, hide `[Tool result for ...]` feed, greeting only per click Start, then free chat with self-heal. Remove `Trace` from bar (`…` → trace) + `rl-inline` fix so bar no longer covers `Deep thinking / Smart Search`. Bump per bump rule.

## 4.0.0 - Complete 111-tool suite (production, one-push)
All 111 tools implemented with Pro Max quality. No API keys required — S21/S48 use offline procedural fallbacks.

- **Core Manipulation 1-7, Scripting 8-15, Snapshot 16-18, Sandbox 19-22, Context 23-28, Dependency 29-33, Perf 34-37, Terrain 38-42, GUI 43-46, Animation 47-50, DataStore 51-53, Team 54-57, Templates 58-60, Misc 61-64, S-Series 65-111**: see `mcp-server/src/tools/registry.ts` (111 ToolDefs).
- **S25 pluginLoader, S28 debugging, S29 level gen, S30 multi-project, S33 predictive, S35 playtest, S37 archive, S38 quests, S40 economy, S43 explainer, S45 DDA, S48 sound** — all wired with offline deterministic mocks (no `OPENAI_API_KEY`/`ELEVEN_LABS_KEY`).
- **Bridge** `4.0.0` deterministic `handle_call_tool`, layered timeouts, AI-readable `kind`.
- **Extension** 1000x polished vs ZeroScript — sequential `ToolExecutionManager`, `AgentFSM`, `trace panel`, `camouflage`, no copyrighted glyph copy.
- **Studio plugin** `studio-plugin/RoLink.lua` 111 handlers + `src/plugin/init.plugin.luau` 200ms poll.
- **File structure** per spec: `mcp-server/src/{analyzer,translator,performance,planner,logger,context,sandbox,playtest,autoFixer,projectArchive,questGenerator,economySim,explainer,ddaEngine,soundGenerator,pluginLoader}` + `tools.ts` re-export.

## 3.1.0 - Reliability-first execution overhaul (phases 1-10)
The 3.0.0 rewrite was correct but the execution path was still racy: the agent loop dispatched tools via `setTimeout` fire-and-forget, so the AI could continue before the tool lifecycle completed. 3.1.0 is the **reliability overhaul** that makes the `AI → Studio → result → AI` loop deterministic.

**Architecture:**
- **Canonical transport** is `bridge.py` (`ws://127.0.0.1:17613`) — sole browser execution path. `bridge/server.py` moved to `bridge/legacy/` (deprecated, reference only). `mcp-server` is an advanced RoLink runtime/tool provider, not a second browser transport.
- **Sequential awaiting:** `agentLoop` now `for(const c of reply.calls) await dispatchTool(...)` (`TOOL_DETECTED→EXECUTING_TOOL→WAITING_FOR_RESULT→FEEDING_RESULT→WAITING_FOR_AI`). No `call 1 ──┐/call2 ──┼── concurrent chaos`.
- **One `ToolExecutionManager`** (`core/execution.js` new, 203 lines): `execute(call)→{id,tool,arguments,startedAt,timeout,status,result,error}` with `queued/running/success/error/timeout/cancelled`, validates, creates `rl_…` request id, timeouts, cancellation, normalized AI-readable errors.
- **Canonical protocol:** `call_tool {id,name,arguments,timeout,sessionId,turnId}` → `tool_result {id,ok,kind,error,text,images}`. Strict request correlation (no “next response” matching). `shared/protocol.ts` adds `CallToolFrame/ToolResultFrame/BridgeState/makeExecutionId`.
- **Bridge deterministic:** `handle_call_tool()` single function (`safe_call`): validate → find target MCP server → ensure alive → execute → wait JSON-RPC → normalize. Returns `studio_offline/mcp_offline/bridge_offline/timeout` instead of fake success. Layered timeouts `extension 130s / bridge 120s / execute_luau 20s`.
- **Formal `AgentFSM`** (`core/agent-state.js` new): `IDLE,STARTING,WAITING_FOR_AI,AI_GENERATING,TOOL_DETECTED,EXECUTING_TOOL,FEEDING_RESULT,WAITING_FOR_RESUME,FINISHED,ERROR,STOPPED` with logged transitions.
- **Transactional feeding:** `feedToolResultTransactional` → `P.typeAndSend` → `waitForGenerationStart(3.5s)` → retry once → `“AI did not resume”` banner. Prevents dropped results.
- **Stale-chat guard:** `sessionId/conversationKey/turnId` per execution; result for old session is discarded, not injected into new chat.
- **Visibility gate owned by ExecutionManager:** `document.hidden → waitForVisible` before send.
- **Tool discovery mandatory:** `startSession` refuses to send starter if `list_tools` returns 0 — shows “RoLink connected, but tools unavailable.”
- **Unified catalogue:** AI sees `RoLink tools` (provider abstraction in `mcp-server/src/tools/registry.ts:unifiedCatalog` + `shared/protocol.ts:UnifiedToolEntry`), not `Roblox+MCP+legacy` competing lists.
- **Trace panel** (`core/execution-trace.js` + `overlay.css` `.rl-trace` + `#rl-trace-btn`): `15:22:01 AI response → Parsed → Request ID → →Bridge → →Studio MCP → ←Studio → ✓ → Feeding → Resumed`.
- **Retired:** `bridge/server.py + auth.py + requirements.txt → bridge/legacy/` with `DEPRECATED.md`.
- **E2E tests** (`tests/execution.test.js` A-J): execute_luau roundtrip, invalid tool, malformed JSON, studio/bridge offline, timeout+retry, stale chat, reload recovery.
- **Version sync:** `VERSION 3.1.0`, `bridge.py BRIDGE_VERSION 3.1.0`, `manifest.json 3.1.0`, `mcp-server/package.json 3.1.0`, `core/config.js ROLINK_VERSION 3.1.0`.

## 3.0.0 - The architectural rewrite: ZeroScript-aligned core
After weeks of patch-driven fixes (v2.0.0 → v2.3.3), the agent loop was
fundamentally less robust than ZeroScript's. v3.0.0 rewrites
`core/main.js` to match ZeroScript v1.5.2's architecture: same state
model, same `submitAndGetBase` (with textarea-clear detection + retry),
same `waitForResponse` (all defensive logic), same `syncSessionState`
(chat-switch handling), same whole-item camouflage sweep, same
`installSendHooks` (onUserMessage re-arms the loop on user send).

**Key architectural ports from ZeroScript v1.5.2:**

- **`submitAndGetBase(text, images)`** — reliable send with the proven
  pattern: pre-hide window, settle-check (200ms), retry loop with
  textarea-clear as the fast gate, fallback to assistantCount. Tagged
  with `myGen` so a chat switch mid-send invalidates the in-flight
  bootstrap and lifts the input cover.

- **`syncSessionState()`** — runs every 1.5s + on visibility change.
  If the user opens a NEW empty chat while a session is active, the
  loop is abandoned cleanly (A.stopping=true, A.loopKey=null). The
  bootstrap is invalidated via `A.startGen++` so its `finally` doesn't
  leave the input cover stuck.

- **`captureSendToken()`** — captures `P.lastAssistantId()` BEFORE
  the send. `waitForResponse` uses this as the `lastSeenAssistantId`
  to detect the new turn. Stable per-turn identity, not count-based.

- **`preHideWholeItems()`** — synchronous pre-hide of freshly injected
  result turns, called from `submitAndGetBase`'s finally block (200ms
  + 700ms). The very next NEW user turn is treated as ours and
  masked on sight (with the `injectHideUntil` window), so the raw
  "Output of '…'" doesn't flash for 200/700ms before the camouflage
  sweep catches it.

- **`wholeItemScan()`** — ZeroScript's `decorate.sweep` pattern.
  Runs every 1.5s. Walks every message item, joins all text nodes
  (excluding our UI), runs `ZSParse.extractAll()` on the joined
  string. Catches tool blocks the per-element live stripper misses
  when the marker + JSON are split across multiple `<p>`/`<div>`
  elements (DeepSeek LUA blocks).

- **`joinItemText(item)`** — TreeWalker-based text join that respects
  the agent's own UI: skips `#rl-root`, `#rl-bar`, chips, hidden
  elements, etc.

- **`waitFor(pred, timeout)`** — promise-based generic wait helper
  (replaces ad-hoc `await sleep()` loops).

- **`jitterBeforeSend()`** — 30-100ms random delay before each send
  attempt. ZeroScript does this to avoid race conditions with the
  site's own React render passes.

- **`A.startGen`** — generation counter bumped on abandon, so
  bootstrap's `finally` checks `myGen === A.startGen` and lifts the
  cover only if it's still the live bootstrap.

- **All the v2.x improvements kept**: lastGoodReply, stuckDone,
  effectiveBlock, genFlickers, sysResendDue, auto-inject
  `datamodel_type` + `studio_id`, camouflage, inputCover, sync
  sentToken on user message, sticky `sessionEverStarted`, etc.

- **Version bump 2.3.3 → 3.0.0** — this is a MAJOR release because
  the agent loop semantics changed (chat-switch handling, send
  reliability, defensive state machine).

## 2.3.3 - Robust tool-block detection: whole-item text scan + immediate onUserMessage scan
The user reported: "the ai web said ###MCP_TOOL### search_game_tree ...
didnt execute". The tool block was in the chat but the agent never
dispatched it. After 2.3.2 fixed the multi-tool-in-one-turn race, a
new failure mode remained: a single tool block in a turn where the
`###MCP_TOOL###` marker is split across multiple DOM elements
(DeepSeek renders LUA blocks across many `<p>` elements; the live
stripper only sees one element at a time).

**Fixes**:
- **Whole-item text scan every 1.5s**. ZeroScript's `decorate.sweep`
  pattern. Walks every message item, joins all text nodes (excluding
  our own UI), runs `ZSParse.extractAll()` on the joined string.
  Catches tool blocks the per-element live stripper misses, because
  the marker + JSON are split across paragraphs/divs.
- **Immediate force-scan on user message**. When the user types a new
  message, the `onUserMessage` hook force-scans the entire chat for
  tool blocks RIGHT NOW. Catches any blocks the MutationObserver and
  the interval scan might have missed.
- **`A.dispatchedItems` WeakSet** tracks which message items have
  already been processed, so the same item doesn't get re-dispatched
  on every 1.5s tick.
- **TreeWalker-based text join** (`joinItemText`) respects the agent's
  own UI: skips `#rl-root`, `#rl-bar`, chips, hidden elements, etc.
- Version bump 2.3.2 → 2.3.3.

## 2.3.2 - Fix: second tool block in same turn was silently dropped
When the model emitted two `###MCP_TOOL###` blocks in one reply (e.g.
`search_game_tree` + `script_search`), only the first one was dispatched
and the second was silently dropped. The user saw both tool blocks in
the chat but no chip, no result, no execution.

**Root cause**: `scanToolBlocks` (the live DOM stripper) returned early
when `A.busy` was true:
```js
if(A.busy) return; // don't race the active dispatch
```
The first tool set `A.busy=true`, the second `<pre>` arrived, the
stripper saw `A.busy=true` and skipped. The second tool was never
dispatched. The waitForReply fallback should have caught it, but the
race window was enough for the model to finalize the turn as "text"
(the model often says "let me also search..." alongside the blocks).

**Fix**:
- **Removed the `A.busy` bail from `scanToolBlocks`**. Each tool gets
  its own dispatch and bridge call, in parallel. The `WeakSet`
  prevents double-dispatching the same `<pre>`, so no risk of
  duplicate runs.
- **Added a 2s safety-net re-scan** that walks `P.allItems()` and
  runs `scanToolBlocks` on each. Catches tool blocks the
  MutationObserver missed (React batched mounts, re-renders, etc).
- Version bump 2.3.1 → 2.3.2.

## 2.3.1 - CRITICAL: fix JS syntax error in core/main.js (button missing)
The "Start RoLink agent" button (and all in-page UI) was missing because
`core/main.js` had a syntax error at line 461. The file had duplicate
text outside any template literal:

  const STARTER = `...Begin with one tool call:

  ###MCP_TOOL###                  ← duplicate, outside any string
  {"tool":"get_studio_state"...

This was caused by a botched edit in 2.3.0 (re-adding the STARTER
constant after it was originally removed by the sysResendDue insert).
`node -c core/main.js` now passes — all content scripts verified.

Also verified all other content scripts parse cleanly:
  core/main.js, core/config.js, core/parser.js
  providers/{generic,deepseek,chatgpt,gemini,kimi,glm,qwen,arena,meta}.js
  background.js, popup.js, options.js

Version bump 2.3.0 → 2.3.1.

## 2.3.0 - Start button loading state, AI greeting, sysResendDue, camouflage, inputCover, diagnostics
The user reported: "when i click the start agent buttons theres must be a loading
starting just like the zerodev to active the bridge ... that ai web chat just
gonna say im ready and the user can chat whatever he can chat".

Fixes:
- **Start button has a proper loading state**: clicking Start now shows a
  purple "Starting…" pill with an inline spinner (CSS @keyframes spin).
  When the system prompt is sent, it transitions to the red "■ Stop
  agent" pill. When the user stops, it returns to the blue "▶ Start
  RoLink agent" pill.
- **Bridge-status preflight at Start**: before sending the system prompt,
  the agent pings the bridge. If the bridge is offline, the user sees
  a red banner "Bridge offline — run start.bat" and the start is
  aborted (no half-baked session). If the bridge is up but Studio's
  MCP server isn't, a warning banner. If everything is connected, a
  green "Bridge connected · 28 tools · Studio ready" message in the
  activity feed.
- **AI greeting**: the new STARTER tells the model to call
  `get_studio_state` and then reply with one short line ending in
  "What would you like to build?" — so the user gets a clear "I'm
  ready" message after clicking Start, and types their actual request
  next (which auto-re-arms the agent loop via `onUserMessage`).
- **`sysResendDue` per-conversation system-prompt re-injection**: some
  sites (esp. ChatGPT) summarize their own context mid-conversation
  and drop the MECHANISM ("I cannot run commands" failure). The agent
  now re-anchors the system prompt on the next injected tool result
  every 12 user turns or 8 tool results, persisted in chrome.storage
  per conversation so it survives page reloads. Rides on the
  tool-result carrier — free, invisible to the user.
- **Camouflage**: the MutationObserver now also hides entire turn
  elements whose text matches the system-prompt marker OR starts with
  `[Tool result for X]` / `[Tool error for X]`. So the user sees clean
  AI replies + tool chips, not the raw injected feedback text.
- **`inputCover` transparent overlay**: during every agent inject
  (system prompt, tool result, nudge), a transparent overlay with
  "🔄 Agent working…" is placed over the input box so the user
  can't accidentally type or click and abort the send. Removed
  automatically when inject finishes.
- **Diagnostics ring buffer**: 300-slot ring of `{t, event, data}`
  entries for postmortem debugging. `window.ROLINK.diag()` to dump.
  Every key event (startSession, dispatch, system-prompt rider,
  loop end) is logged.
- Version bump 2.2.0 → 2.3.0.

## 2.2.0 - studio_id auto-inject + agent loop re-arms on user message
After the 2.1.2 "auto-inject datamodel_type" fix, the bridge revealed
a SECOND required arg: `studio_id`. Nearly every tool requires it. The
model had to call `list_roblox_studios` first, get the id, then pass it
to every subsequent call — but it kept forgetting.

- **Auto-inject `studio_id`**: `dispatchTool` now silently adds
  `studio_id: A.currentStudioId` to every call (except
  `list_roblox_studios` itself). Captured at session-start by an
  auto-probe, or live whenever the model calls `list_roblox_studios`.
- **Auto-inject `datamodel_type`** (from 2.1.2, kept) — same pattern.
- **`installSendHooks` wired**: ZeroScript-style user-send interception
  on every site. The generic factory now installs real keydown + click
  listeners that call `onUserMessage(assistantCount)` when the user
  presses Enter or clicks Send. This is what makes the agent loop
  re-arm after the model says "DONE" — the user types a new message,
  the agent loop spins up a new iteration automatically.
- **Sticky `sessionEverStarted`**: once the user clicks Start, the
  `isStarted` flag stays true across loop iterations. So after the
  agent's final text reply, the user can keep typing and the loop
  keeps restarting without needing to click Start again.
- **Native stop/continue hooks**: clicking the AI site's own stop button
  latches `userStopped=true` (suppresses auto-resume). Clicking
  Continue clears it.
- **Per-site deepseek.js already had real hooks** — this also works
  for the other 7 sites now via the generic factory.
- Version bump 2.1.2 → 2.2.0.

## 2.1.2 - Auto-inject datamodel_type + tool schemas in system prompt
The bridge returned `datamodel_type is required` for every `execute_luau`
call because the model has no way to know which DataModel is focused
without first calling `get_studio_state`. The model had to guess the
field name, then got the JSON escaping wrong, then looped.

- **`startSession` auto-probes** `get_studio_state` before sending the
  starter, captures the focused DataModel into `A.focusedDataModel`,
  and surfaces it in the activity feed.
- **`dispatchTool` auto-injects** `datamodel_type` for the 16 tools that
  require it (execute_luau, multi_edit, script_read, script_grep,
  inspect_instance, start_stop_play, search_game_tree, delete_instance,
  set_property, get_property, generate_asset, search_assets, import_asset,
  insert_asset, search_asset, get_console_output, get_snapshot). The
  model never needs to know this argument exists.
- **`buildSystemPrompt` now embeds the inputSchema for every tool** so
  the model sees the exact required/optional args. Signature is shown as
  `toolName(arg1*, arg2, arg3)` where `*` marks required. Descriptions
  are truncated to 100 chars.
- **Better error feedback on `X is required`**: the agent now parses
  the bridge's error text, finds the missing field, looks up the tool's
  inputSchema, and tells the model exactly what to add:
  > "The 'execute_luau' tool requires these arguments:
  >  code (required): string — Luau code to execute
  >  datamodel_type (required): string
  > You were missing: 'datamodel_type'."
- The system prompt now also notes that datamodel_type is auto-injected,
  so the model doesn't try to pass it itself.
- Version bump 2.1.1 → 2.1.2.

## 2.1.1 - Critical fix: ###LUA### blocks were dispatched as 'run_code' (not the real tool name)
The bridge log `20:23:51 <- run_code (0.0s): unknown tool 'run_code'` revealed a
real bug: the parser was hardcoded to wrap `###LUA###` blocks as
`{tool: "run_code"}`, but the bridge only advertises `execute_luau`. The system
prompt correctly told the model to use `execute_luau`, but the parser silently
rewrote the model's `###LUA###` form into a different tool name that the
bridge rejected, putting the model into an infinite parse_error loop.

This is also why the model in the bug report kept emitting the same broken
JSON: it tried `###LUA###` first (correct per the prompt), the parser mangled
it to `run_code`, the bridge said "unknown tool", the model then tried the
JSON form with `execute_luau` and missed the quote-escaping, and so on.

- **`parser.js`**: `###LUA###` blocks now wrap to `{tool: "execute_luau"}` (the
  real advertised name), not `run_code`.
- **`config.js` + `main.js` system-prompt template**: example calls now use
  `execute_luau` (and the fallback "begin by trying..." list no longer
  mentions `run_code`).
- **`parser.js` `hasToolSignature` regex**: removed `run_code` from the
  tool-name list (it's not a real tool), added the names the bridge
  actually advertises (multi_edit, script_read, script_grep, inspect_instance,
  search_game_tree) so the agent's "is this a tool call?" check is correct.
- **Version bump 2.1.0 → 2.1.1**.

## 2.1.0 - Defensive response watcher + cut-off salvage
After studying ZeroScript v1.5.2's waitForResponse (4374 lines), ported
the critical defensive logic that prevents the "model said the tool
call but the agent did nothing" failure:

- **`lastGoodReply` fallback**: if a read comes back empty for a single
  frame (React re-render of a turn's subtree, a hidden <pre> re-creating
  itself), classify the last non-empty read instead of declaring the
  turn "empty" and ending the loop. Reset per turn node.
- **`stuckDone` fallback**: if the generating flag is stuck ON but the
  text has been frozen for STABLE_MS (wedged stop button, seen on
  Gemini), finalize anyway. Bypasses the gen branch entirely.
  Guarded: NEVER fires while a tool block is open AND gen is genuinely
  on, so a model that just paused between tokens isn't misfinalized.
- **`genOffFirstAt` + `genFlickers` tracking**: distinguish "first real
  stop" from "post-stop DOM churn" so the watcher doesn't wait out a
  render flicker.
- **`genStopped` / `effectiveBlock`**: an "open tool block" reading only
  blocks finalization while gen is still active OR the text has changed
  in the last 6s. After GEN_STOP_GRACE_MS of gen-off, an open block is
  treated as DOM churn, not live output.
- **`salvageCutOffCall`**: when a JSON envelope is missing closing
  braces (a big multi_edit or execute_luau cut off by the output
  limit), auto-close and run it instead of burning a retry turn.
  Refuses amputated content (odd number of unescaped quotes = mid-string
  cut) so we never run a half-written command.
- **`replyUnsettled` guard**: for Qwen A/B dual turns, hold off on parse
  verdict while the provider says the read isn't stable. Bounded by
  UNSETTLED_GRACE_MS so a genuinely stuck read still resolves.
- **Multiple parse_error reasons**: `malformed`, `unclosed`, `luaOpener`
  (model wrote `###END_LUA###` without `###LUA###`), `envelope` (bare
  function-calling JSON without `{"command":...}` wrapper). Each gets
  a specific nudge.
- **Tool-name validation on parse_error**: don't fire parse_error for
  prose that just MENTIONS a command name. Only fire when the named
  tool is actually in the live bridge tool list.
- **Bumped to 2.1.0**.

## 2.0.1 - Fix: multiple tool calls per reply, malformed-JSON escape hints
- **CRITICAL FIX in `core/parser.js` `extractAll()`**: the previous version
  called `text.search(LUA_START_RE)` instead of `text.slice(i).search(...)`,
  so when a reply had two `###MCP_TOOL###` blocks it only found the first
  (and only sometimes). Now the function scans forward from position `i`
  and returns every block in document order. Verified with a real reply
  that emits `get_studio_state` + `list_roblox_studios` back to back —
  both are now dispatched.
- **`scanToolBlocks` (live DOM stripper) now extracts ALL tool blocks from
  each `<pre>` element**, not just the first. If the model emits two blocks
  in one code block, both chips appear and both tools get dispatched.
  Previously the second block was silently dropped, the agent classified
  the reply as a single-tool turn, the model stopped after the first
  result came back, and the session went silent.
- **`###LUA###` form is now advertised in the system prompt** so the model
  knows it can avoid JSON-escaping hell by using:
  ```
  ###LUA###
  <luau code, no escaping>
  ###END_LUA###
  ```
- **Better parse_error feedback**: when the model emits invalid JSON (the
  classic "double quotes inside the code string"), the nudge now shows a
  worked example of BOTH the escaped `###MCP_TOOL###` form AND the
  escaping-free `###LUA###` form, plus the exact escape rules.
- Version bump 2.0.0 → 2.0.1.

## 2.0.0 - The "1000x" rewrite: aggressive agent, live stripping, session memory, native-tool lockdown
- **AI no longer gets away with "What would you like to build?"** The agent now
  detects when the model's reply is a question (or "I'll await your instructions")
  and auto-nudges it to ACT, up to 4 times per session. System prompt explicitly
  says: "Pick one and start building. The user will redirect if they want
  something different." This is the fix for the demo where the model called one
  tool, got the result, and then stopped.
- **AI no longer gets away with "I cannot run commands".** The agent detects
  the common "I can't run / I don't have access / I'm unable to" patterns and
  re-grounds the model with the actual live tool list inline.
- **LIVE tool-block stripping** (`scanToolBlocks` in `core/main.js`): the moment
  `###MCP_TOOL###` appears in the DOM (mid-stream), the raw block is hidden
  and the chip is inserted. The user never sees the raw `{"tool":...}` JSON
  flashing on screen. This runs on every mutation, with a `WeakSet` to dedupe.
- **Native-tool lockdown** in the system prompt: the model is told to ONLY use
  the RoLink tools, NEVER its own built-in code interpreter, web search, file
  browser, etc. (Kimi, Gemini, Qwen all ship with their own native tools and
  will use them if not told not to.)
- **Workspace / session memory panel** (🧠 button in the bar): shows the
  current session ID, event count, and a textarea for **custom instructions**
  that are appended to the system prompt and persisted across sessions via
  `chrome.storage.local`. The session history is also persisted per
  conversation key.
- **Per-site provider factory pattern** (`providers/generic.js`): rewritten as
  `window.makeGenericProvider(opts)` that builds a complete ZSProvider with
  the correct `SELF` id baked into the closure. All 7 thin wrappers
  (gemini/kimi/glm/qwen/arena/meta/chatgpt) now call this factory instead of
  doing an `Object.assign` shallow copy (which silently kept the "generic"
  prefix in `itemKey` ids).
- **Image attach works on every site**, not just DeepSeek. The generic factory
  includes a default `attachImages` that tries `input[type="file"]` first,
  then falls back to a `ClipboardEvent("paste")` with `DataTransfer`. Per-site
  providers can override.
- **Arena Direct-mode gate**: clicking Start on arena.ai with Battle /
  Side-by-Side / Agent selected now refuses and tells the user to switch to
  Direct.
- **system_prompt V3**: shorter, more imperative. Two patterns (tool / DONE),
  no prose padding. Includes the ACT-FIRST rule and the native-tool ban.
- **Bigger live tool-result truncator**: tool results over 12 000 chars are
  truncated to 11 500 + a marker so context never blows up on a giant
  `get_snapshot`.
- **Reset WeakSet on session start** so re-clicking Start after a session
  doesn't get confused by already-hidden blocks.
- **Version bump 1.3.1 → 2.0.0** across all versioned files.

## 1.3.1 - Dynamic system prompt: real tool names from the bridge
- The system prompt no longer hardcodes a fake tool list. It is now built
  dynamically from `list_tools` at session start, so the model always sees
  the exact tool names the bridge currently advertises. Falls back to a
  generic starter list if the bridge isn't ready yet.
- `refreshTools()` now retries up to 4 times with backoff (0.6/1.2/1.8/2.4s)
  so the bridge has time to come up. `startSession()` awaits it before
  building the prompt, so the model never gets sent into the AI with stale
  or missing tool names.
- When the model gets back `unknown tool 'X'`, the error feedback now
  includes the actual current tool list inline: "The valid tool names
  right now are: a, b, c… Pick the closest one." This breaks the
  'try-tool → fail → claim I can't run code' loop that the demo showed.
- Starter prompt tightened: "Begin now (first message — call tools
  immediately, no prose preamble)" + asks for `get_studio_state` /
  `list_roblox_studios` first (so the model doesn't fire `get_snapshot`
  on a closed place).
- Version bumped to 1.3.1 across all files.

## 1.3.0 - Real ZeroScript-style ZSProvider architecture (the way ZeroDev does it)
- **`core/parser.js` is back as a proper ZSParse module** with `extract`, `extractAll`, `hasToolSignature`, `hasOpenToolBlock`, `toolNameFromText`, `normalize`. Recognizes: `###MCP_TOOL### {json}`, `###LUA### ... ###END_LUA###`, raw JSON code blocks (`{"command":...}`), function-calling flavour (bare JSON with `tool`/`command`/`function` key). Tolerant of cut-off JSON (auto-closes braces), DeepSeek `<|DSML|>` stripping, tab escaping.
- **`providers/deepseek.js` is now a full ZeroScript-quality ZSProvider** (1000+ lines, transcribed from the proven v1.5.3 codebase and rebranded to RoLink):
  - **Stable per-turn identity** via `data-virtual-list-item-key` (DeepSeek virtualizes its message list — counts alone are wrong when old turns detach; this key survives scroll/rerender).
  - **Real `isGenerating()` detection** from three orthogonal signals: `.ds-loading` spinner, footer button glyph (the same button doubles as SEND and STOP — distinguished by the `<path d>` starting with `M2` (stop square) vs `M8` (send arrow)), and stream-growth tracking (the only liveness signal during the reasoning phase when there is no stop button).
  - **`isBusyNow()`** is a strict version: true only when a generation is actively happening RIGHT NOW, so the send never aborts a turn mid-stream.
  - **Send-locked composer** during agent activity (`readonly` attribute + "RoLink agent working, please wait..." placeholder, with the dataset-captured original placeholder restored on unlock).
  - **163,840-char input cap** with head+tail truncation + explicit marker so the model knows the gap and doesn't re-run.
  - **Composer mode control**: at session start, force the Expert tab (most powerful) unless the user has explicitly chosen Vision (so `screen_capture` is honored) or Instant.
  - **`installSendHooks`** intercepts Enter / send-button click / native Stop / native Continue so the agent can react to user actions during a session.
  - **Image attachment** via real file-input upload (idempotent — won't double-attach across retries).
  - **`findToolBlockSpot`** hides the raw `###MCP_TOOL###` / `###LUA###` block (and its code-fence wrapper) before the chip is inserted, so nothing of the raw command flashes on screen.
  - **Context-limit / too-long / stopped** detection from site chrome (not model output).
- **`providers/generic.js`** is a "good enough" ZSProvider for the other 7 sites (Gemini, Kimi, GLM, Qwen, Arena, Meta AI, ChatGPT). Per-site providers are now thin wrappers that layer on top of the generic one.
- **`core/main.js` is now a true ZeroScript-style agent loop**:
  - **System prompt injection** as the first user message (proven to make the AI treat it as directives, not a question).
  - **Bootstrap gates** on `ensureComposerReady` (waits for Expert/Instant/Vision to be selected on DeepSeek, up to 1.4s).
  - **Classifies each AI reply** as: tool (dispatch + chip), text (loop ends, AI answered), truncated (click Continue / nudge to redo), parse_error (fix-it nudge), context_limit (stop + banner), too_long (nudge to start new chat), empty (auto-resume: re-feed last result up to 12 times), stopped/timeout (stop).
  - **Auto-resume watchdog**: if the AI drops a tool result on the floor (empty reply after a feed), the loop re-sends the same payload with a "no reply received" header.
  - **Tab-visibility gate**: pauses the loop when the AI tab is hidden (background tabs throttle rendering), resumes immediately on unhide.
  - **Input-lock during inject** so the user can't accidentally abort a send.
  - **Live activity feed** (right side, color-coded) + **tool counter** in the status bar.
- **Per-site provider pattern** preserved: `providers/<site>.js` exports `window.ZSProvider`; the core never touches site DOM directly. Adding a new AI site = drop a thin wrapper over `generic.js` + add to manifest.
- **Manifest load order** updated: `core/config.js` → `core/parser.js` → `providers/generic.js` (when applicable) → `providers/<site>.js` → `core/main.js`.
- Sync 1.3.0 across all versioned files.
- **`core/main.js` is now a real agentic loop**, not a "send one message and watch" stub. Inspired by ZeroDev/Lemonade:
  - **Strong system prompt as the first message** — injected as a user message (the AI treats it as directives). Lists EVERY tool with the exact `###MCP_TOOL### {json}` format, with a "DONE" stop signal, and the rule "Never claim you cannot run commands".
  - **Automatic tool dispatch** — scans every new `<pre>` block in the AI's replies for `###MCP_TOOL###` JSON, dispatches via `bg({type:"call_tool"})`, replaces the raw block with a **beautiful tool chip** (icon + tool name + args + live result). Supports multiple tool calls per AI reply.
  - **Automatic result feed-back** — after each tool runs, the result is sent back to the AI as a hidden message so the loop continues until the AI is done.
  - **Plain-text nudge** — if the AI replies with text (no tool block), the agent automatically sends a nudge: "If you want to act, output `###MCP_TOOL### {json}`. If done, answer the user." Capped at 6 nudges to avoid infinite loops.
  - **Question detection** — if the AI asks a clarifying question, the agent nudges it to make reasonable assumptions and ACT (the ZeroDev pattern: agents should not ask, they should build).
  - **Stop signal** — the loop ends when the AI's reply is plain text AND there's no tool signature AND no recent feed-back (the AI is done).
  - **Robust tool detection** — also recognizes `"command":` / `"tool":` / `"name":"execute_luau"` etc. in function-calling JSON shapes (DeepSeek function-calling, Kimi native tools).
- **Activity feed** (right side of the page) — live scroll of every event: agent started, tool call (icon + name + args), tool result (✓ or ✗ + preview), nudge sent, finished. Color-coded. Timestamps. Clearable. The user sees exactly what the AI is doing in real time.
- **Tool counter** in the status bar — "3 tools" badge so the user knows progress.
- **Wider tool detection** — `run_code`, `execute_luau`, `create_instance`, `set_property`, `get_snapshot`, `get_instance_tree`, `list_roblox_studios`, `get_studio_state`, `search_assets`, `import_asset`, `generate_asset`, `start_stop_play`, `screen_capture`, `publish_place`, etc. all recognized.
- **Popup "Start" button** now sends `rolink-start` to the in-page launcher (the AI tab), with a fallback `chrome.scripting.executeScript` that programmatically clicks the page button if the content script isn't ready yet.
- **Manifest version sync + activity feed styling in `overlay.css`** (with proper color-coded event rows, monospace timestamps, scrollbar styling).
- Sync 1.2.0 across all versioned files.
- `manifest.json`: every `content_scripts` entry referenced `core/parser.js` (deleted in 1.1.8) and `web_accessible_resources` referenced `core/inject.js` (also deleted) — Chrome refused to load the extension with "Could not load javascript 'core/parser.js' for script." All entries now list only the files that exist: `core/config.js`, the per-site `providers/*.js` (sets `window.ROLINK_PROVIDER`), and `core/main.js`. Added `www.kimi.ai` to the Kimi match pattern. Dropped `inject.js` from `web_accessible_resources`.
- Sync 1.1.9 across all versioned files.
- **WS path fix:** `background.js` was still trying `ws://127.0.0.1:17613/ws?role=extension&token=dummy` (a path ZeroScript's bridge doesn't serve). Now connects to the root `ws://127.0.0.1:17613`, matching the bridge. Fixes the `ERR_CONNECTION_REFUSED` spam and the 7-client / 7-disconnect thrash.
- **New in-page UI (`core/main.js` + `overlay.css`):**
  - **Centered "▶ Start RoLink agent" button** at the top-center of every AI page (gradient blue, glowing on hover, becomes a "■ Stop" pill with a square dot when active — same idea as ZeroScript's launcher but bigger and more prominent).
  - **Status bar** anchored above the chat composer (auto-tracks the input's position on resize). Green/yellow/grey dot, "Bridge + Studio ready" / "Enable MCP in Studio" / "Bridge OK · open Studio" / "offline — run start.bat".
  - **Tools panel** (top-right, toggled by the 🛠 Tools button): floating card listing every MCP tool the AI can call, with a count pill. Updates live from `list_tools`.
  - **Beautiful tool chips:** every `###MCP_TOOL### {json}` block the AI emits is hidden and replaced with a chip showing the tool name + args (loading spinner → green ✓ + result text / red ✗ + error text). Chips have a glassmorphic gradient look, an icon, the tool name in monospace, and the result inline.
  - **Automatic agent loop:** after each tool runs, its result is fed back to the AI in a hidden message so the loop continues until the AI decides it's done. No more "I cannot run commands" — the AI gets the result and immediately picks the next step.
  - **Click "Start" once** and the system prompt + starter question are injected, Send is auto-clicked, the page is observed for new tool blocks forever.
  - **Toggleable Stop** by clicking the active launcher (turns red-ish, stops injection, shows a banner).
  - All UI is in a `#rl-root` container with `pointer-events:none` so it never blocks the host site's clicks; only the buttons/inputs have `pointer-events:auto`.
- **Popup (`popup.html` + `popup.js`):** redesigned to a clean centered "Start RoLink agent" button (big gradient, prominent) at the top, then Reconnect / Restart Roblox server buttons, then a tools-list chip cloud, then footer instructions. Replaces the older busy layout.
- **Background.js:** fixed the WS path bug. Now also broadcasts status to all provider tabs on every state change (so the in-page launcher updates its dot color in real time).
- **Removed** `core/inject.js` and `core/parser.js` (their functionality is now inside `core/main.js`).
- Sync 1.1.8 across all versioned files.
- **bridge.py** is now ZeroScript's battle-tested 2041-line version (ZBS v1.5.3 architecture), rebranded to RoLink. Includes: parallel MCP server startup, `MCPManager` with tool-name collision handling (`server/tool` prefix), `probe_studio` (two-level Studio app/place probe via `list_roblox_studios` + `get_studio_state`), `server_watch` (auto-restart dead servers, crash-loop detection, port-squatter forensics), `studio_watch` (Studio attach/detach transitions, sustained-empty catalogue recovery, zombie StudioMCP.exe reclaim), `_reclaim_bridge_port` (only kills processes whose cmdline contains `bridge.py`), `_kill_orphan_studio_mcp` (safe when Studio is closed, skipped when open), `_reclaim_studio_port` (kill StudioMCP.exe that isn't ours by PID-tree), `_kill_port_squatter` (ropilot-style hijack via proven stderr signature), `action_banner` (high-contrast ACT-NOW instructions for non-technical users), `_Spinner` (animated console progress that doesn't fight other spinners), full `start.bat`-free port-reclaim + friendly bind-error.
- **launch_studio_mcp.py** is ZeroScript's robust launcher: skips zombie Studio version folders, prefers newest paired install, supports `ROLINK_STUDIO_MCP_PATH` env override, handles both Windows + macOS app bundles.
- **Extension** (`rolink-extension/`) now routes every tool call through `background.js` (which owns the single bridge WS), not via a second WS from the AI tab. `core/main.js` parses `###MCP_TOOL###` blocks in the AI's replies, calls `bg({type:"call_tool", name, arguments})`, and renders the result as a green/red chip. Status updates (dot color, "Roblox Studio ready" / "enable MCP" / "offline") now driven by ZeroScript's `connected` broadcast with `mcp_alive` + `studio` (place) + `studio_app` (process) fields. The popup reads `list_tools` to show the tool list; `start agent` injects a system prompt + starter into the active AI tab.
- **start.bat** simplified to ZeroScript's `[1/3] Python` → `[2/3] websockets` → `[3/3] bridge` flow (no more banner block). Reclaims :17613 then launches `bridge.py`. The bridge itself prints the colored `RoLink Bridge · Roblox Studio · ws://127.0.0.1:17613` banner, the timestamped `configured N MCP server(s)`, `[roblox] launching (C:\Python310\python.exe ...\launch_studio_mcp.py)`, `[roblox] ready (N tools)`, `ready N tools available`, `listening on ws://127.0.0.1:17613 - load the extension and open a supported AI chat`.
- **`config.json`** ships with `{"mcpServers":{"roblox":{"command":"launch_studio_mcp.py","args":[]}}}`.
- Removed: `mcp-server/` from the runtime path (still in repo for power users, no longer required); the manual MCP `http_fallback` (bridge talks StudioMCP directly).
- Sync 1.1.7 across all versioned files.
- `bridge.py`: the new `websockets.asyncio.server` API passes `(connection, request)` to `process_request` (where `request` is a `websockets.http11.Request` object with `.path`/`.headers`), not the old `(path, request_headers)` tuple. Old signature raised `AttributeError: 'ServerConnection' object has no attribute 'split'` on every WS handshake. Now we read `request.path` and use `connection.respond(200, body)` for the health endpoint.
- Sync 1.1.6 across all versioned files.
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
