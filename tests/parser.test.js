// SPDX-License-Identifier: GPL-3.0-or-later
// tests/parser.test.js — node-runnable parser regression suite.
// Run with: node tests/parser.test.js  (no deps required)
//
// The extension is loaded into a fake window so the core/code-fields.js shim
// can be installed before requiring core/parser.js.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadInSandbox() {
  const codeFields = fs.readFileSync(
    path.join(__dirname, "..", "rolink-extension", "core", "code-fields.js"),
    "utf8"
  );
  const parser = fs.readFileSync(
    path.join(__dirname, "..", "rolink-extension", "core", "parser.js"),
    "utf8"
  );
  const ctx = { window: {}, globalThis: {}, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(codeFields + "\n" + parser, ctx);
  return ctx.window.ZSParse;
}

const ZSParse = loadInSandbox();
let passed = 0, failed = 0;

function assert(cond, msg) { if (!cond) throw new Error("ASSERT FAILED: " + msg); }
function eq(a, b, msg) { assert(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }
function ok(name) { console.log(`✓ ${name}`); passed++; }
function fail(name, e) { console.error(`✗ ${name}: ${e.message}`); failed++; }
async function run(name, fn) { try { await fn(); ok(name); } catch (e) { fail(name, e); } }

function loadFixture(p) {
  return fs.readFileSync(path.join(__dirname, "..", "rolink-extension", "core", "__fixtures__", "tool-calls", p), "utf8");
}

(async () => {
  // ── 1: edge cases (manual) ────────────────────────────────────────────
  await run("edge-01 valid ###MCP_TOOL###", async () => {
    const r = ZSParse.extract(loadFixture("edge-01-valid-mcp-tool.txt"));
    eq(r?.tool, "execute_luau", "tool");
    eq(r?.args?.code, "print('hello world')", "code");
  });

  await run("edge-02 valid ###LUA### block", async () => {
    const r = ZSParse.extract(loadFixture("edge-02-valid-lua-block.txt"));
    eq(r?.tool, "execute_luau", "tool");
    assert(r?.args?.code?.includes("Instance.new"), "code present");
  });

  await run("edge-03 unescaped inner quotes — repairs", async () => {
    const r = ZSParse.extract(loadFixture("edge-03-unescaped-inner-quotes.txt"));
    eq(r?.tool, "set_script_content", "tool");
    assert(r?.args?.content?.includes('"quotes"'), "content with embedded quotes recovered");
    assert(r?.repaired, "repaired flag set");
  });

  await run("edge-04 raw newlines in string — repairs", async () => {
    const r = ZSParse.extract(loadFixture("edge-04-raw-newlines-in-string.txt"));
    eq(r?.tool, "set_script_content", "tool");
    assert(r?.args?.content?.includes("Instance.new(") || r?.args?.content?.includes("Instance.new"), "newlines handled");
  });

  await run("edge-05 truncated mid-string — REJECTS", async () => {
    const before = ZSParse.getNudgeStats().midStringTruncation;
    const r = ZSParse.extract(loadFixture("edge-05-truncated-mid-string.txt"));
    eq(r, null, "must be null");
    const after = ZSParse.getNudgeStats().midStringTruncation;
    assert(after > before, "midStringTruncation counter must increment");
  });

  await run("edge-06 truncated mid-object — salvage", async () => {
    // v5.4.0 path: the v5.4.0 scanBalancedObject sees the chunk as
    // unbalanced (missing `}`), then repairJSONStringValues + salvageObject
    // rescue the call because the string body is plain text with no
    // unescaped quotes. The result is the tool name + the unterminated
    // string body. v5.5.0 documents this as "we keep v5.4.0's salvage as
    // a fallback because the depth-tracking scanner is too strict for
    // the v5.4.0-style chunks the existing tests cover; the v5.5.0
    // depth-tracking scanner is the source of truth for NEW payloads
    // and the breaker test (deferred)."
    const r = ZSParse.extract(loadFixture("edge-06-truncated-mid-object.txt"));
    eq(r?.tool, "set_script_content", "tool recovered");
  });

  await run("edge-07 command/params alias", async () => {
    const r = ZSParse.extract(loadFixture("edge-07-command-params-alias.txt"));
    eq(r?.tool, "create_instance", "tool from command alias");
    eq(r?.args?.className, "Part", "className");
  });

  await run("edge-08 function/arguments alias", async () => {
    const r = ZSParse.extract(loadFixture("edge-08-function-arguments-alias.txt"));
    eq(r?.tool, "set_properties", "tool from function alias");
    eq(r?.args?.path, "Workspace.MyPart", "path");
  });

  await run("edge-09 bare object (no markers)", async () => {
    const r = ZSParse.extract(loadFixture("edge-09-bare-object-no-markers.txt"));
    eq(r?.tool, "create_instance", "tool extracted from bare object");
  });

  await run("edge-10 RAW block merges into args", async () => {
    const r = ZSParse.extract(loadFixture("edge-10-raw-block-merge.txt"));
    eq(r?.tool, "set_script_content", "tool");
    assert(r?.args?.content?.includes('Instance.new("Part")'), "RAW content merged");
    eq(r?.args?.path, "Workspace/Script", "json path");
  });

  await run("edge-11 ###TOOL: name with RAW block", async () => {
    const r = ZSParse.extract(loadFixture("edge-11-tool-raw-block.txt"));
    eq(r?.tool, "set_script_content", "tool");
    // The RAW block's body is consumed verbatim — the parser does NOT try
    // to JSON-unescape it (that's the whole point of the escape hatch).
    assert(typeof r?.args?.content === "string" && r.args.content.length > 20, "content present");
    assert(r?.args?.content?.includes("RAW") || r?.args?.content?.includes("local x"), "content carried through");
    eq(r?.args?.path, "Workspace/Script", "json path");
  });

  await run("edge-12 truncated inside an unterminated string — REJECTS", async () => {
    const r = ZSParse.extract(loadFixture("edge-12-truncated-must-reject.txt"));
    eq(r, null, "must be null");
  });

  await run("edge-13 fenced json block", async () => {
    const r = ZSParse.extract(loadFixture("edge-13-fenced-json.txt"));
    eq(r?.tool, "send_notification", "tool from fenced json");
  });

  await run("edge-14 code field with unescaped quotes (handlerCode)", async () => {
    const r = ZSParse.extract(loadFixture("edge-14-code-field-with-unescaped.txt"));
    eq(r?.tool, "add_event_handler", "tool");
    assert(r?.args?.handlerCode?.includes("print(other.Name)"), "handlerCode recovered");
  });

  await run("edge-15 nested edits[].new_text/old_text", async () => {
    const r = ZSParse.extract(loadFixture("edge-15-nested-new_text-old_text.txt"));
    eq(r?.tool, "multi_edit", "tool");
    assert(Array.isArray(r?.args?.edits) && r.args.edits[0]?.new_text === "local x = 1", "edits recovered");
  });

  // ── Phase 2 fixtures (ZeroScript parity) ───────────────────────────
  await run("edge-16 ###LUA:Client### datamodel suffix", async () => {
    const r = ZSParse.extract(loadFixture("edge-16-datamodel-suffix.txt"));
    eq(r?.tool, "execute_luau", "tool");
    eq(r?.args?.datamodel_type, "Client", "datamodel_type from marker");
    assert(r?.args?.code?.includes("Instance.new"), "code present");
  });

  await run("edge-17 bare ###LUA### defaults to Edit datamodel", async () => {
    const r = ZSParse.extract(loadFixture("edge-17-bare-lua-defaults-to-edit.txt"));
    eq(r?.args?.datamodel_type, "Edit", "default datamodel_type");
  });

  await run("edge-18 cleanLuaCall strips markers from execute_luau code", async () => {
    const r = ZSParse.extract(loadFixture("edge-18-clean-lua-call-strips-markers.txt"));
    eq(r?.tool, "execute_luau", "tool");
    // After cleanLuaCall: no leading ###LUA###, no trailing ###END_LUA###.
    assert(!/###LUA###/.test(r?.args?.code || ""), "no leading marker");
    assert(!/###END_LUA###/.test(r?.args?.code || ""), "no trailing marker");
    assert(r?.args?.code?.includes("Instance.new"), "body preserved");
    eq(r?.args?.datamodel_type, "Edit", "datamodel adopted from inner marker");
  });

  await run("edge-19 'Copy ' chrome stripped from code", async () => {
    const r = ZSParse.extract(loadFixture("edge-19-code-chrome-stripped.txt"));
    eq(r?.tool, "execute_luau", "tool");
    // After stripCodeChrome: body starts with `local`, not `Copy`.
    assert((r?.args?.code || "").startsWith("local"), "Copy prefix removed");
  });

  await run("edge-20 salvageCutOff: missing closing }", async () => {
    // Construct a cut-off JSON directly (one missing `}`) and call the
    // salvager. The default `extract` path would either repair or fail
    // depending on heuristics; this test pins the salvager's contract.
    const cutOff = '{"tool":"multi_edit","args":{"edits":[{"path":"Script1","new_text":"local x = 1","old_text":"local x = 0"}]}}';
    const trimmed = cutOff.slice(0, cutOff.length - 1); // remove final }
    const r = ZSParse.salvageCutOff(trimmed);
    eq(r?.tool, "multi_edit", "salvage tool");
    assert(Array.isArray(r?.args?.edits) && r.args.edits[0]?.new_text === "local x = 1", "edits recovered");
    assert(r?.repaired, "repaired flag set");
    eq(r?.repairReason, "salvaged-cut-off", "repair reason");
  });

  await run("edge-21 LUA:Server suffix + 'Copy ' chrome combine", async () => {
    const r = ZSParse.extract(loadFixture("edge-21-lua-suffix-plus-code-chrome.txt"));
    eq(r?.args?.datamodel_type, "Server", "Server datamodel");
    assert((r?.args?.code || "").startsWith("local"), "Copy chrome stripped from LUA body");
  });

  await run("salvageCutOff exported and callable", async () => {
    assert(typeof ZSParse.salvageCutOff === "function", "exported");
    const text = '{"tool":"create_instance","args":{"className":"Part"';
    const r = ZSParse.salvageCutOff(text);
    eq(r?.tool, "create_instance", "salvage tool");
    eq(r?.args?.className, "Part", "salvage args");
  });

  await run("cleanLuaCall is idempotent", async () => {
    const r = ZSParse.extract('###LUA###\nprint(1)\n###END_LUA###');
    eq(r?.args?.datamodel_type, "Edit", "default");
    // Re-run cleanLuaCall on the result; it must not change anything.
    const r2 = ZSParse.cleanLuaCall(r);
    eq(r2?.args?.code, r?.args?.code, "idempotent code");
    eq(r2?.args?.datamodel_type, "Edit", "idempotent datamodel");
  });

  // ── 2: 111 generated tool fixtures — round-trip per tool ──────────────
  const fixtureDir = path.join(__dirname, "..", "rolink-extension", "core", "__fixtures__", "tool-calls");
  const fixtures = fs.readdirSync(fixtureDir).filter(f => f.endsWith(".txt") && !f.startsWith("edge-") && f !== "README.txt");
  await run(`111-tool round-trip (${fixtures.length} fixtures)`, async () => {
    assert(fixtures.length >= 111, `expected >= 111 tool fixtures, found ${fixtures.length}`);
    for (const f of fixtures) {
      const txt = loadFixture(f.replace(/^.*[\\/]/, ""));
      const r = ZSParse.extract(txt);
      const expectedTool = f.replace(/\.txt$/, "");
      assert(r, `${f} should parse`);
      eq(r.tool, expectedTool, `${f} tool name`);
    }
  });

  // ── 3: probe signals ─────────────────────────────────────────────────
  await run("getNudgeStats / resetNudgeStats", async () => {
    ZSParse.resetNudgeStats();
    ZSParse.extract("###MCP_TOOL### {\"tool\":\"create_instance\",\"args\":"); // truncated mid-object
    ZSParse.extract("###MCP_TOOL### {\"tool\":\"x\",\"args\":{\"code\":\"unterminated"); // truncated mid-string
    const s = ZSParse.getNudgeStats();
    assert(s.midStringTruncation >= 1, "midStringTruncation recorded");
    ZSParse.resetNudgeStats();
    eq(ZSParse.getNudgeStats().midStringTruncation, 0, "reset clears");
  });

  await run("hasToolSignature / hasOpenToolBlock / toolNameFromText", async () => {
    assert(ZSParse.hasToolSignature('###MCP_TOOL### {"tool":"a","args":{}}'), "mcp signature");
    assert(ZSParse.hasToolSignature('###LUA### print(1) ###END_LUA###'), "lua signature");
    assert(ZSParse.hasToolSignature('###TOOL:foo###'), "tool raw signature");
    assert(ZSParse.hasOpenToolBlock('###MCP_TOOL### {"tool":"x","args":'), "open block");
    assert(!ZSParse.hasOpenToolBlock('###MCP_TOOL### {"tool":"x","args":{}}'), "balanced block not open");
    eq(ZSParse.toolNameFromText('{"tool":"create_instance","args":{}}'), "create_instance", "tool name");
    eq(ZSParse.toolNameFromText('###TOOL:execute_luau###'), "execute_luau", "raw tool name");
  });

  console.log(`\nParser tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
