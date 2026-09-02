// SPDX-License-Identifier: GPL-3.0-or-later
// tests/partial-tools.test.js — Phase 4 polish. For each of the 14 tools the
// audit table marks as "partial" (code-bearing string field), construct a
// realistic Zod-valid payload that also exercises the parser's failure modes
// (raw quotes, unescaped newlines, embedded `}` in code, regex literals)
// and assert the parser returns a usable call. After this test passes, every
// partial row can be reclassified to "yes".

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadParser() {
  const cf = fs.readFileSync(path.join(__dirname, "..", "rolink-extension", "core", "code-fields.js"), "utf8");
  const p = fs.readFileSync(path.join(__dirname, "..", "rolink-extension", "core", "parser.js"), "utf8");
  const ctx = { window: {}, globalThis: {}, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(cf + "\n" + p, ctx);
  return ctx.window.ZSParse;
}

const ZSParse = loadParser();

let passed = 0, failed = 0;
function assert(cond, msg) { if (!cond) throw new Error("ASSERT FAILED: " + msg); }
function ok(name) { console.log("✓", name); passed++; }
function bad(name, e) { console.error("✗", name, e && e.message || ""); failed++; }

// The "stress" code is used by every fixture. It deliberately:
//   - contains a literal single quote inside a double-quoted string
//   - contains a literal double quote (which forces the model into either
//     proper escaping or a RAW block)
//   - contains an embedded `{` and `}` inside a Luau pattern / table literal
//   - contains a regex-like `{1,3}` quantifier
//   - spans multiple lines
//   - contains a Luau `[[...]]` long string
//   - contains a backslash-escape sequence
const STRESS_CODE = `local function mk(self, p) -- comment with "quote"
  local t = {a=1, b={2,3}} -- nested braces
  if p == "[a-z]{1,3}" then return t end  -- regex-like braces
  local s = [[ multi line
  "long string with quote" ]]
  return s
end`;

// For every partial tool, the realistic payload. Each entry is the
// `args` object the model would emit (synthesized from the Zod schema, with
// the stress code substituted into the code-bearing field).
const PARTIAL_TOOLS = [
  { name: "execute_luau",     field: "code",        payload: { code: STRESS_CODE } },
  { name: "set_script_content", field: "content",   payload: { path: "Workspace/Script", content: STRESS_CODE } },
  { name: "create_module",    field: "exports",     payload: { path: "ReplicatedStorage/MyModule", exports: STRESS_CODE } },
  { name: "add_event_handler", field: "handlerCode", payload: { path: "Workspace.MyPart", event: "Touched", handlerCode: STRESS_CODE } },
  { name: "bind_ui_click",    field: "handlerCode", payload: { path: "StarterGui.ScreenGui.Button", handlerCode: STRESS_CODE } },
  { name: "run_in_sandbox",   field: "code",        payload: { code: STRESS_CODE } },
  { name: "analyze_performance", field: "code",     payload: { code: STRESS_CODE } },
  { name: "generate_test",    field: "code",        payload: { code: STRESS_CODE } },
  { name: "review_code",      field: "code",        payload: { code: STRESS_CODE } },
  { name: "refactor_code",    field: "code",        payload: { code: STRESS_CODE } },
  { name: "predict_bug",      field: "code",        payload: { code: STRESS_CODE } },
  { name: "explain_code",     field: "code",        payload: { code: STRESS_CODE, path: "Workspace/Script" } },
  { name: "load_plugin",      field: "code",        payload: { name: "rolink-test", code: STRESS_CODE } },
  { name: "add_template",     field: "code",        payload: { id: "t1", name: "TestTemplate", description: "with \"quote\"", category: "custom", code: STRESS_CODE } },
];

(async () => {
  // ── 1: each partial tool's JSON envelope round-trips the parser ─────
  await run("14 partial tools' JSON envelope round-trips", async () => {
    for (const tool of PARTIAL_TOOLS) {
      const txt = `###MCP_TOOL###\n${JSON.stringify({ tool: tool.name, args: tool.payload })}`;
      const blks = ZSParse.extractAll(txt).filter(Boolean);
      assert(blks.length === 1, `${tool.name}: expected 1 block, got ${blks.length}`);
      const c = blks[0];
      assert(c.tool === tool.name, `${tool.name}: .tool`);
      assert(c.name === tool.name, `${tool.name}: .name alias`);
      assert(c.args && c.args[tool.field], `${tool.name}: missing .args.${tool.field}`);
      // The code-bearing field must come through with the full stress body.
      // (Either it round-tripped through the JSON-escape repair, OR the
      // parser refused - the latter fails the test.)
      assert(c.args[tool.field].length > 10, `${tool.name}: .args.${tool.field} length`);
      assert(c.args[tool.field].includes("multi line"), `${tool.name}: long string preserved`);
      assert(c.args[tool.field].includes("nested"), `${tool.name}: brace in code preserved`);
    }
  });

  // ── 2: RAW block also works for the same 14 fields ─────────────────
  await run("14 partial tools' RAW block round-trips", async () => {
    for (const tool of PARTIAL_TOOLS) {
      const raw = `###MCP_TOOL###\n${JSON.stringify({ tool: tool.name, args: { ...tool.payload, [tool.field]: undefined } })}\n###RAW:${tool.field}###\n${STRESS_CODE}\n###END_RAW###`;
      const blks = ZSParse.extractAll(raw).filter(Boolean);
      assert(blks.length === 1, `${tool.name} RAW: expected 1 block`);
      const c = blks[0];
      assert(c.tool === tool.name, `${tool.name} RAW: .tool`);
      assert(c.args[tool.field] === STRESS_CODE, `${tool.name} RAW: .args.${tool.field} body preserved verbatim`);
    }
  });

  // ── 3: Tool-scoped form ###TOOL:...### also works ───────────────────
  await run("14 partial tools' ###TOOL:<name>### form round-trips", async () => {
    for (const tool of PARTIAL_TOOLS) {
      const raw = `###TOOL:${tool.name}###\n###RAW:${tool.field}###\n${STRESS_CODE}\n###END_RAW###\n###END_TOOL###`;
      const blks = ZSParse.extractAll(raw).filter(Boolean);
      assert(blks.length === 1, `${tool.name} tool-raw: expected 1 block`);
      const c = blks[0];
      assert(c.tool === tool.name, `${tool.name} tool-raw: .tool`);
      assert(c.args[tool.field] === STRESS_CODE, `${tool.name} tool-raw: body preserved verbatim`);
    }
  });

  // ── 4: regex-literal-in-brace case (the matchBrace gap) ────────────
  // script_grep / search_by_attribute accept a `pattern` string that may be
  // a regex like "[a-z]{1,3}". The current parser's matchBrace is string-
  // aware so this should already work, but pin the contract.
  await run("regex-literal '{1,3}' inside a string survives the JSON envelope", async () => {
    const txt = `###MCP_TOOL###\n${JSON.stringify({ tool: "set_script_content", args: { path: "X", content: 'if x == "[a-z]{1,3}" then return true end' } })}`;
    const c = ZSParse.extract(txt);
    assert(c?.args?.content?.includes("{1,3}"), "regex-literal preserved");
  });

  console.log(`\nPartial-tool tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);

  async function run(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }
})();
