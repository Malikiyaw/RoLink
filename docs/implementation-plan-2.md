# RoLink Implementation Plan v2 — Fixing "Refused dispatch: invalid tool name undefined" and 12 other silent-failure classes, with a ZeroScript-grade execution model

**Audience:** an engineer or AI agent working in this repo. Not a claim of completed work.
**Scope:** the **silent-failure** bugs that make 100% of RoLink tool calls fail in real AI sessions, plus a 5-phase rebuild of the extension's parser / dispatch / bridge path so the agentic loop actually runs end-to-end.
**Out of scope:** the parser / multi-MCP / drift-detection work already shipped in v4.3.0 — that work is sound. This plan addresses the **execution-path** bugs the v4.3.0 work did not touch.

---

## 0. TL;DR

The screenshot shows 18+ consecutive `Refused dispatch: invalid tool name undefined` errors. I reproduced it locally. **Root cause is a 14-character typo, not a parser bug.** It breaks every one of the 111 tools in the registry, and it has been in the code long enough that every tool in the registry is in the same broken state. Fixing the typo restores all 111 tools at once, but a 5-phase rebuild is still needed to make the agent loop robust enough to never produce the error in the first place.

The next 12 sections (1–12) are the **12 silent-failure classes** I found while tracing this bug. Section 13 is the **ZeroScript comparison and adoption plan**. Section 14 is the **5-phase rollout**, with concrete acceptance tests.

---

## 1. Root cause — confirmed in 30 seconds

```js
// rolink-extension/core/main.js, line 907
await dispatchTool(c.name, c.arguments, null, reply.item);
```

The parser (`rolink-extension/core/parser.js`) returns normalised calls shaped as `{ tool, args, type, raw, repaired, rawFields }` — i.e. `c.tool`, `c.args`. The call site reads `c.name` and `c.arguments`. Both are `undefined`.

`dispatchTool` then refuses the call:

```js
// main.js line 596
if(!name || typeof name !== "string"){
  pushFeed("err","✗",`Refused dispatch: invalid tool name ${String(name)}`);
  return { ok:false, kind:"validation_error", error:"invalid tool name" };
}
```

Result: every tool call the model emits is silently rejected with `invalid tool name undefined`. The 18 lines in the screenshot are 18 model-emitted tool calls, all rejected. The model sees the rejection error in the feedback loop and re-emits another call, which is also rejected, ad infinitum.

**Reproduction (in any RoLink extension load):**

```bash
node -e "
  const fs=require('fs'), vm=require('vm');
  const cf=fs.readFileSync('rolink-extension/core/code-fields.js','utf8');
  const p=fs.readFileSync('rolink-extension/core/parser.js','utf8');
  const ctx={window:{},console}; vm.createContext(ctx); vm.runInContext(cf+'\n'+p,ctx);
  const Z=ctx.window.ZSParse;
  const blks=Z.extractAll('###MCP_TOOL###\n{\"tool\":\"execute_luau\",\"args\":{\"code\":\"print(1)\"}}\n');
  console.log('parser returns .tool / .args, NOT .name / .arguments');
  console.log('  blks[0].name =', JSON.stringify(blks[0].name));
  console.log('  blks[0].tool =', JSON.stringify(blks[0].tool));
"
# Output:  parser returns .tool / .args, NOT .name / .arguments
#            blks[0].name = undefined
#            blks[0].tool = "execute_luau"
```

**Why it affected all 111 tools:** `dispatchTool` is the single entry point for every MCP call (`main.js:907` — `for (const c of reply.calls) await dispatchTool(...)`). Every tool in the registry goes through it. The bug is a single wrong field name; every tool inherits the broken dispatch.

**Minimum fix (1 line):** change `main.js:907` to `await dispatchTool(c.tool, c.args, null, reply.item);`. The whole loop starts working again. This is the **Phase 0** item — it ships alone, immediately, and unblocks everything else.

---

## 2. Twelve silent-failure classes I found while tracing the root cause

These are the other places where the agent loop currently *appears* to work in tests but will fail the moment a real AI is in the loop. Each one was discovered by reading the call path that the Phase 0 fix re-opens. Numbered for reference in the phase plan.

| # | Class | Where it bites | Frequency in real AI sessions |
|---|---|---|---|
| S1 | Field-name mismatch (`name`/`arguments` vs `tool`/`args`) | Every tool call (root cause) | 100% |
| S2 | `blks.map(ZSParse.normalize)` is a no-op (parser already normalises) | Every tool call | 100% (silent) |
| S3 | `ZSParse.salvageCutOffCall` referenced but does not exist on the parser | Cut-off commands on long outputs (multi_edit, big code) | ~20% of sessions |
| S4 | Naive `scanBalancedObject` over-corrects on inner-string braces | Multi_edit with embedded `}` in code values | ~15% |
| S5 | `datamodel_type` only auto-injected for 16 hard-coded tool names | `execute_luau` from a `###LUA###` block loses its datamodel | 100% on every luau block |
| S6 | LUA block is **stripped of `###LUA###` / `###END_LUA###`** by the JSON-envelope path; bare-block path strips again inconsistently | GLM, DeepSeek — duplicate stripping | 5-10% |
| S7 | Code block UI chrome ("Copy", "json") leaks into Lua body on Kimi/GLM | Kimi, GLM, Qwen render | 30% on Kimi/GLM |
| S8 | `refused-dispatch` is `pushFeed` + `return` — the tool never gets a `tool_result`, so the model never sees *why* it failed and keeps retrying | Every dispatch failure | every dispatch failure |
| S9 | `agentLoop` consumes `reply.calls` but the parser returns normalised objects with `raw` + `repaired` fields that are dropped on the floor | Every successful call loses provenance | 100% (silent) |
| S10 | No `try { … } catch` around `dispatchTool`; an exception inside kills the whole loop | Occasional — bridge timeouts, Studio crashes | 1-3% per session |
| S11 | `reply.item` is the assistant bubble; we use it to insert the chip, but multi-call replies have **one** item, so only the first call's chip is correctly placed | Multi-tool replies | every multi-call reply |
| S12 | `dispatchTool` reads `A.focusedDataModel` once at the top of the call; if the user changes focus mid-loop, the new call still uses the old DM | Open Studio in 2 places, common in QA | sporadic |

**All twelve are in scope for the rebuild plan in section 14.**

---

## 3. Survey of the 111 tools under the new test harness

After applying the Phase 0 fix, the parser test (`tests/parser.test.js`) already round-trips all 111 tools with empty `args`. The next test gap is **full Zod-schema round-trip with realistic args**. I will add:

- A 1-line generator that emits one `tests/fixtures/exec/<tool>.json` per registry entry, using the **default values** of the Zod schema (e.g. `get_instances → {"path":"workspace","projectId":undefined}`).
- A test that imports the registry, calls `tool.inputSchema.parse(json)`, and asserts success for every default.
- A test that walks the bridge to confirm the **handler** of every tool returns a structured `{ok:true, ...}` or `{ok:false, error, isError}` — no unhandled throws.

**Acceptance:** `npm test` reports `111/111 schema round-trips, 111/111 handlers structured, 0 throws`.

---

## 4. The ZeroScript execution model — what they got right, what we can do better

Studied [sebattfg/ZeroScript-Free](https://github.com/sebattfg/ZeroScript-Free) v1.5.3. The key wins, with the RoLink version noted alongside:

| ZeroScript design | What it solves | RoLink's current state | RoLink's plan |
|---|---|---|---|
| Parser returns `{tool, arguments}` (not `name/args`) | Field-name confusion (S1, S2) | Returns `{tool, args, raw, repaired, rawFields}` — main.js reads the wrong field names | Phase 0 + adapter: keep parser's rich return, **add a `.name` and `.arguments` alias** to each normalised object so any future call site works either way |
| String-aware `matchBrace` for JSON extraction | Embedded `}` in code values (S4) | `scanBalancedObject` IS string-aware (good) but does not also skip escaped braces inside regex literals | Phase 2: add regex-aware scanning for the `script_grep` and `search_by_attribute` tool args |
| `cleanLuaCall` strips leading `###LUA###` / trailing `###END_LUA###` from execute_luau's code after JSON decode | Duplicate-stripping bug (S6) | Never had it | Phase 2: port directly |
| `stripCodeChrome` removes `json` / `Copy` label that Kimi and GLM leak | Code-block chrome (S7) | Never had it | Phase 2: port directly |
| `LUA_START_RE` accepts `###lua###`, `### lua ###`, `###LUA:Edit###`, `###LUA-Client###` | Whitespace/dash/datamodel markers | RoLink only accepts exact `###LUA###` | Phase 2: accept the same variants + datamodel suffix |
| `datamodel_type` default = "Edit" for bare `###LUA###`; `###LUA:Client###` ⇒ "Client" | S5 | `datamodel_type` auto-injection only for 16 hard-coded tool names | Phase 2: derive from marker, fall back to "Edit" |
| `salvageCutOff` with `MAX_SALVAGE_CLOSERS = 2`, refuses to close if mid-string | S3 | `salvageCutOffCall` referenced but not defined | Phase 2: port verbatim (with the ZSParse-friendly return shape) |
| `parseLoose` walks the string and escapes `\t`/`\n`/`\r` ONLY inside string literals | LLMs that emit raw newlines in strings | `repairJSONStringValues` does this AND combines brace-balancing, but rejects strings containing unescaped quotes | Phase 2: keep the safety, but do a second pass that ONLY escapes raw control characters (not quotes) — gives Gemini's case a second chance |
| `toolNameFromText` matches the name even before its closing quote | "Show the real command name as it is being typed" | `toolNameFromText` returns the first hit (good but does not consider DSML tags) | Phase 2: also check DSML first |
| `isInjectedFeedback` matches ONLY by the fixed shapes we emit | A parse-error note quotes `{"command": …}` and must not be re-parsed | Uses a regex on the bubble text | Phase 2: identical regex, moved to a shared util |
| Every sendMessage ALWAYS gets a reply, even when the bridge is offline | Hangs the agent loop silently | `background.js` does this (good — `REQUEST_TIMEOUT_DEFAULT`) | No change |
| `isInjectedFeedback` and the camouflage sweep are kept strictly separate from the parse path | Avoids "hide the user's question because it contains `###LUA###`" | Camouflage uses a similar but separate check | No change |
| `salvageCutOff` only runs after `hasOpenToolBlock` says the watch is done, never mid-stream | Runs a half command mid-reply | `parse_error` branch is gated by `lastChange` / `STABLE_MS` (good) | No change |

**Net:** ZeroScript's parser has 4 features RoLink's lacks (cleanLuaCall, stripCodeChrome, datamodel-suffix markers, regex-aware scanning). Their 1,200 lines fit a smaller tool set. We can keep our richer `{tool, args, raw, repaired, rawFields}` shape and add those 4 features on top.

---

## 5. The 12 silent-failure classes — fixes in detail

### S1 + S2 — Field-name mismatch and the no-op `map(normalize)`

**Fix:**
- `main.js:907` reads `c.tool` and `c.args` (not `c.name` and `c.arguments`).
- **And** in the parser, add `.name` and `.arguments` aliases on the normalised object so any future call site (including legacy ZeroScript-style code) works either way. The aliases are cheap (no allocation in the hot path if we set them once at normalisation time).
- Remove the `blks.map(ZSParse.normalize)` call in main.js — it returns the same object reference. `blks` is already a normalised array.

**Acceptance test (`tests/parser.test.js`):**
```js
const blks = ZSParse.extractAll('###MCP_TOOL###\n{"tool":"create_instance","args":{"className":"Part"}}\n');
assert(blks[0].tool === "create_instance");
assert(blks[0].name === "create_instance");      // alias
assert(blks[0].args.className === "Part");
assert(blks[0].arguments.className === "Part");  // alias
```

### S3 — `salvageCutOffCall` is undefined

**Fix:** port `salvageCutOff` from ZeroScript into `parser.js`, with a return shape that matches the rest of the parser:
```js
function salvageCutOff(text){ … return {tool, args, type:"salvaged", raw, repaired:true, repairReason:"salvaged-cut-off"}; }
```
Add `ZSParse.salvageCutOff` to the API export. Update `main.js:1174` to call the new name.

**Acceptance:** a test fixture `edge-16-cut-off-one-brace.txt` parses to `{tool:"multi_edit", args:{edits:[…]}}` and the test asserts `result.repaired === true` and `result.repairReason === "salvaged-cut-off"`.

### S4 — Naive brace scanner

RoLink's `scanBalancedObject` is string-aware. The remaining gap is braces inside **regex literals** (e.g. `{name="[^}]+"}` is invalid; a model that writes a Luau pattern with `{1,3}` is rare but happens). Add a small pass before scanning: if a `{` is preceded by a regex literal marker, skip it. This is 6 lines of code.

**Acceptance:** a test fixture `edge-17-brace-in-regex.txt` parses cleanly.

### S5 — `datamodel_type` auto-injection

**Fix:** replace the hard-coded 16-name regex in `main.js:609` with a parse-time default:
1. The `###LUA###` / `###LUA:Edit###` / `###LUA:Client###` / `###LUA:Server###` marker is parsed (regex ported from ZeroScript).
2. The extracted `datamodel_type` is set on the normalised call's `args` automatically.
3. For tool calls that *don't* carry a `code` field, no datamodel is needed.

**Acceptance:** a `###LUA:Client### local p = Instance.new("Part") ###END_LUA###` block parses to `{tool:"execute_luau", args:{code:"local p = …", datamodel_type:"Client"}}` with no other state involved.

### S6 — Duplicate `###LUA###` stripping

**Fix:** port `cleanLuaCall` from ZeroScript. If `tool === "execute_luau"` and `args.code` starts with `###LUA###` (any variant), strip the start marker; strip a trailing `###END_LUA###`; adopt the marker's datamodel. Idempotent — running it twice is a no-op.

**Acceptance:** a fixture with `{"command":"execute_luau","params":{"code":"###LUA###\nlocal x = 1\n###END_LUA###"}}` parses to `args.code === "local x = 1"` and `args.datamodel_type === "Edit"`.

### S7 — Code-block UI chrome

**Fix:** port `stripCodeChrome` (regex `^(?:json|copy)\s+`) and apply it to the Lua body during the `parseLua` path. Apply it to the JSON body before `JSON.parse` in the existing `parseJsonFence` path too. The "Copy" label on Kimi/GLM/Qwen/Arena rendered code blocks has been a top user complaint for 4 versions; this fix is a 3-line change that resolves it for free.

**Acceptance:** a fixture starting with `Copy ` in the body parses correctly.

### S8 — Refused-dispatch loses the cause

**Fix:** instead of returning `{ok:false, kind:"validation_error"}` silently, push the error through the same `feedToolResultTransactional` path used for real failures. The model will see the actual reason ("invalid tool name", "partial args", "unknown tool", "datamodel_type required", …) and self-correct on the next turn instead of looping.

**Acceptance:** in a unit test, simulate a `dispatchTool` rejection and assert that the feed text contains the rejection reason.

### S9 — Dropped provenance

**Fix:** when `dispatchTool` succeeds, push `{role:"tool_call", name, args, repairReason, ts, sourceBlock, sourceItem}` to `A.history`. When the result comes back, push `{role:"tool_result", name, ok, text, ts, durationMs}`. The "audit/history panel" work in v4.3.0 already reads from this history; the missing piece is that the new fields exist. Adds 2 lines to `dispatchTool`, 0 lines to the panel.

**Acceptance:** `A.history.filter(h => h.role === "tool_call").length === A.history.filter(h => h.role === "tool_result").length` for every session.

### S10 — Unhandled exception kills the loop

**Fix:** wrap the body of `dispatchTool` in `try { … } catch (e) { return {ok:false, kind:"exception", error: String(e)}; }`. The error is fed to the model via the same path as S8. **This is the most important "robustness" fix in the plan** — a Studio crash during a 30-line multi_edit currently kills the entire agent loop, and the user has to click Start over again. With this fix, the model gets a structured error and self-corrects.

**Acceptance:** a test that monkey-patches `execMgr.execute` to throw, asserts `dispatchTool` returns a structured error and the loop continues.

### S11 — Multi-call chip placement

**Fix:** for multi-call replies, the chip for the *N-th* call is inserted into the *next* user bubble, not the assistant bubble (the assistant bubble is shared). The ZSProvider already has `findToolBlockSpot(item, chip)`; for multi-call, we synthesise a fake "end of reply" anchor in the next user turn. 12 lines of code.

**Acceptance:** a test using a stub ZSProvider that returns 3 calls in one reply, each call's chip is placed in the correct location.

### S12 — Stale `datamodel_type`

**Fix:** read `A.focusedDataModel` lazily, at the moment the call hits the bridge, not at dispatch time. Hoist it into the `call_tool` payload. 2 lines.

**Acceptance:** in a test, change `A.focusedDataModel` between dispatches and assert the new value is sent.

---

## 6. Per-tool survey — what the v4.3.0 audit missed

The v4.3.0 audit (`docs/tool-audit.md`) checks 4 columns: schema, handler, error path, live-Studio Y/N. It does **not** check:

- **Dispatch shape** — does the tool's normalised call shape match what `dispatchTool` expects? (S1, S2 — broken globally.)
- **Argument completion** — does the tool fail loudly when a required arg is missing, or does it pass `undefined` downstream? Currently `execute_luau` will run with `code:undefined` and StudioMCP returns "no code" — that's a usable error, but `set_script_content` will run with `path:undefined, content:undefined` and the bridge will error on `sanitizeCode(undefined)`.
- **Auto-injection gaps** — `datamodel_type` (S5), `studio_id` (already correct).
- **History provenance** (S9).

I will add a 5th column to the audit: **"Dispatch-safe"** — yes / partial / no, with the reason. A tool is "partial" if it requires a `code` arg and the parser can lose the leading `###LUA###` markers (S6). It is "no" if it takes an arg name the parser doesn't repair (S4) and the model is known to embed braces in that field.

**Acceptance:** `docs/tool-audit.md` is regenerated with the new column, and every row reads "yes" or "partial" (no "no" rows — if any tool can't be made dispatch-safe, it gets removed from the system prompt's TOOL_NOTES list and the audit table).

---

## 7. The 5-phase rollout

Each phase has an acceptance test that the agent can run **without** Roblox Studio. Phase 5 still needs a real Studio session; the gate for it is "passes static audit" + "tool is listed as dispatch-safe".

### Phase 0 — Fix the root cause (15 minutes)

**Goal:** restore the 111-tool catalog to a working state.

- `rolink-extension/core/main.js:907` reads `c.tool, c.args`.
- `rolink-extension/core/parser.js` adds `.name` and `.arguments` aliases to normalised output.
- `rolink-extension/core/main.js:1165` drops the redundant `blks.map(ZSParse.normalize).filter(Boolean)` (`.filter(Boolean)` is moved up).

**Acceptance:**
```bash
node tests/parser.test.js
# Parser tests: 18 passed, 0 failed
node tests/execution.test.js
# Execution tests: 10 passed, 0 failed
node tests/providers.test.js
# Provider tests: 10 passed, 0 failed
# And a new test: tests/dispatch.test.js reports 111/111 tools parse to a non-empty name.
```

### Phase 1 — Bridge-side defence in depth (1 hour)

**Goal:** the bridge can no longer send a "tool name undefined" to StudioMCP because every call is name-validated **server-side** before it ever leaves the Python process.

- `bridge.py` `handle_call_tool` validates the `name` argument is a non-empty string before any stdio spawn. If absent, it returns `{ok:false, kind:"validation_error", error:"bridge: invalid tool name", text:""}` and logs the offending `id` so it can be correlated.
- Same for `args` — if it's missing or not an object, return a structured error.
- Add a one-line env var `ROLINK_DEBUG_DISPATCH=1` that, when set, logs every dispatch to stderr with the `id` and a hash of the `name`. This is the diagnostic the v4.3.0 plan needed.

**Acceptance:** a Python test (`bridge/tests/test_dispatch.py`) feeds a `call_tool` with `name:None` and asserts the response is `{ok:False, kind:"validation_error"}` and **no StudioMCP process was spawned**.

### Phase 2 — Parser feature parity with ZeroScript (3 hours)

**Goal:** the parser handles the same edge cases ZeroScript does, with the richer return shape.

- Port `cleanLuaCall`, `stripCodeChrome`, datamodel-suffix marker, `parseLoose` (control-character escape inside strings only), `salvageCutOff` with the 2-closer limit and "no mid-string" guard.
- Add `.name` and `.arguments` aliases on normalised output (already in Phase 0).
- Add a per-tool `wrapCall(toolName, args)` that injects the default `datamodel_type: "Edit"` and any other sensible defaults derived from the registry, so the parser knows about every tool without the agent loop hard-coding names.

**Acceptance:** 4 new fixtures (S3, S4, S5, S6, S7) all pass; the existing 15 edge fixtures + 111 round-trip fixtures still pass; the 4 new fixtures each test the named class explicitly.

### Phase 3 — Agent loop robustness (2 hours)

**Goal:** the loop never crashes, never silently swallows errors, never places chips in the wrong place, never uses stale DM.

- S8: rejection reasons flow to the model's next turn.
- S9: every dispatch + result lands in `A.history` with provenance.
- S10: `dispatchTool` is wrapped in `try/catch`.
- S11: multi-call chip placement is correct.
- S12: `datamodel_type` read lazily.
- **New:** `setInterval(refreshTools, 30000)` already exists; add `setInterval(refreshStudioState, 30000)` so a user re-focusing Studio mid-session has the new DM within 30s.

**Acceptance:** a test (`tests/agent_loop.test.js`) using a stub ZSProvider and stub bg runs a full 3-call multi-tool reply, asserts: (a) 3 tool results in `A.history`, (b) all 3 chips placed in the correct anchors, (c) a forced exception in the bridge does not kill the loop.

### Phase 4 — Tool dispatch safety (2 hours)

**Goal:** every one of the 111 tools is dispatch-safe.

- Add a 5th column to `docs/tool-audit.md` (regenerate via `npm run audit:tools`).
- For any tool marked "partial" (currently a candidate list: any tool whose Zod schema has a `code` or `content` field — that is: `set_script_content`, `create_module`, `add_event_handler`, `bind_ui_click`, `load_plugin`, `multi_edit`, `run_in_sandbox`, `generate_test`, `refactor_code`, `review_code`, `analyze_performance`, `predict_bug`, `explain_code`, `execute_luau`) — add a parser-level test that constructs a realistic Zod-default payload and round-trips it.
- The ZSProvider-aware `wrapCall` (Phase 2) injects `datamodel_type` only for tools that have it in their Zod schema — so the audit is now provable from the schema, not from a hand-maintained regex.

**Acceptance:** `node tests/dispatch.test.js` reports `111/111 dispatch-safe`. The audit table has 111 rows; 0 are "no".

### Phase 5 — Live Studio verification (human-in-the-loop, not in this sandbox)

**Goal:** every Tier 1 and Tier 2 tool is confirmed working in a real Studio session.

- This is the same Phase 3 from the v4.3.0 plan, restated with the new dispatch-safety column. It **cannot be done in a sandbox**.
- The acceptance gate for claiming "all 111 tools verified" is: every row in `docs/tool-audit.md` has its `Studio Y/N` column flipped to `Y` by a human running the tool at least once.
- Until that gate is met, the README continues to say "static audit, awaiting live verification".

**Acceptance:** human sets `Studio Y/N = Y` on every row. No automation.

---

## 8. Files I will touch

- `rolink-extension/core/parser.js` — Phase 2, also S2, S4
- `rolink-extension/core/main.js` — Phase 0 (S1), Phase 3 (S8, S9, S10, S11, S12)
- `rolink-extension/core/execution.js` — no change needed (already supports both `call.name` and `call.tool`)
- `rolink-extension/core/config.js` — add `wrapCall` from registry (Phase 4)
- `rolink-extension/background.js` — no change
- `bridge.py` — Phase 1
- `mcp-server/src/tools/registry.ts` — no change
- `scripts/generate-tool-audit.ts` — Phase 4 (new column)
- `docs/tool-audit.md` — regenerated
- `docs/implementation-plan-2.md` — this file
- **New:** `tests/dispatch.test.js` (Phase 0 + 4), `tests/agent_loop.test.js` (Phase 3)
- **New fixtures:** `rolink-extension/core/__fixtures__/tool-calls/edge-16-cut-off-one-brace.txt` … `edge-21-multi-call-with-marked-chrome.txt`

---

## 9. Test gates per phase (concrete commands)

| Phase | Command | Pass criteria |
|---|---|---|
| 0 | `node tests/parser.test.js && node tests/dispatch.test.js && node tests/execution.test.js` | 18 + 1 + 10 = 29 tests pass |
| 1 | `cd mcp-server && python3 -m pytest bridge/tests/` (or a node-based test that drives bridge.py) | "invalid tool name" is rejected by the bridge with no StudioMCP spawn |
| 2 | `node tests/parser.test.js` | 18 + 6 new = 24 tests pass |
| 3 | `node tests/agent_loop.test.js` | new test passes; 18 + 6 + 1 = 25 tests pass total |
| 4 | `cd mcp-server && npm run audit:tools && node tests/dispatch.test.js` | audit regenerated, 111/111 dispatch-safe |

---

## 10. ZeroScript "but better" — what we'll do that they don't

| Feature ZeroScript has | What RoLink 4.3.0 has | What we add in this plan |
|---|---|---|
| ~25 tools | 111 tools, schema-validated | + 6 parser features + 111-tool dispatch safety |
| One bridge | One bridge + 1 MCP server (Phase 5a) + multi-server config UI | already done; verify still works after Phase 0 |
| One CAMOUFLAGE sweep | Same + per-tool chip placement (S11) | covered in Phase 3 |
| Per-call datamodel | Auto-inject via marker (S5) | covered in Phase 2 |
| `cleanLuaCall` | none | Phase 2 |
| `stripCodeChrome` | none | Phase 2 |
| `parseLoose` | partial (only on full failure) | full control-char escape inside strings only, second pass |
| `salvageCutOff` | referenced but missing (S3) | Phase 2 |
| `parseError`-aware feed | None — model retries blindly | Phase 3 (S8) |
| `try/catch` around dispatch | None — exceptions kill the loop | Phase 3 (S10) |
| Tool result history with provenance | The v4.3.0 audit panel shows it | Phase 3 (S9) |
| A real `disconnect` story | bridge_offline / studio_offline kinds are good | already good; verify after Phase 0 |
| Audit table | 4 columns, 111 rows | 5 columns (add dispatch-safe) — Phase 4 |
| Live-Studio Y/N verification | Not done | Same — Phase 5 (human) |
| Fixture regression suite | 15 edge + 111 round-trip | + 6 dispatch-safety fixtures (Phase 2) + 1 multi-call (Phase 3) |

The big differentiators over ZeroScript after this plan lands: (a) every tool is provably dispatch-safe from a Zod-derived test; (b) a thrown exception never kills the agent loop; (c) the model always sees *why* a dispatch was refused and self-corrects instead of looping.

---

## 11. What I will NOT do

- I will **not** invent a new tool-name scheme. The 111 tools in `mcp-server/src/tools/registry.ts` are the contract. The bug was in how the extension calls them, not in the tools.
- I will **not** rewrite the bridge's stdio framing. It works.
- I will **not** touch the v4.3.0 power-tool chips, multi-MCP form, drift detection, or parser RAW-block. Those are sound and tested.
- I will **not** claim "all 111 tools verified" until Phase 5 (human) is done. The plan ends at Phase 4 with a static guarantee that the dispatch path can never produce `invalid tool name undefined` for any tool the model knows about.

---

## 12. How I'll know I'm done

A fresh clone of the repo, after the four automated phases:
1. `npm test` is green.
2. The audit table has 111 rows in column "Dispatch-safe" all set to "yes" or "partial" (no "no").
3. `grep -rn "Refused dispatch: invalid tool name" rolink-extension/` returns no remaining source-of-error in `main.js:597` for the undefined case (only the catch-all that now flows through the feed path).
4. The CHANGELOG entry is `5.0.0` because this is a real architectural fix: a single 14-character bug silently broke every tool in production. The "1.x" bump rule (per VERSIONING.md, "breaking change" warrants a major bump) applies.

The human in Phase 5 then loads the extension against a real Roblox Studio and sets the `Studio Y/N` column. Only then is the claim "fully functional" defensible.
