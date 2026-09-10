// SPDX-License-Identifier: GPL-3.0-or-later
// tests/chip-resume.test.js — missed-turn watchdog + executed-memory suite.
// Run with: node tests/chip-resume.test.js   (no deps)
//
// The watchdog helpers live inside main.js's IIFE, so this suite evaluates
// the real function source (sliced by markers) in a sandbox with a stubbed
// session object — no copies, no DOM.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.join(__dirname, "..", "rolink-extension");
let passed = 0, failed = 0;
function assert(c, m) { if (!c) throw new Error("ASSERT FAILED: " + m); }
function ok(n) { console.log(`✓ ${n}`); passed++; }
function fail(n, e) { console.error(`✗ ${n}: ${e && e.message}`); failed++; }
async function run(n, fn) { try { await fn(); ok(n); } catch (e) { fail(n, e); } }

function loadHelpers(history) {
  const src = fs.readFileSync(path.join(EXT, "core", "main.js"), "utf8");
  const startMark = "// ── watchdog executed-memory (double-fire guard) ──";
  const endMark = "// ── dispatch a tool call (canonical, awaited, id-correlated) ──";
  const a = src.indexOf(startMark);
  const b = src.indexOf(endMark);
  assert(a >= 0 && b > a, "helper slice markers present");
  const slice = src.slice(a, b);
  const ctx = {
    A: { executedCmds: new Map(), history: history || [] },
    JSON, Object, String, Number, Map,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(slice, ctx);
  return ctx;
}

(async () => {
  const mainSrc = fs.readFileSync(path.join(EXT, "core", "main.js"), "utf8");

  await run("normCmdKey is arg-order insensitive", async () => {
    const ctx = loadHelpers();
    const k1 = ctx.normCmdKey("create_instance", { className: "Part", name: "Crate" });
    const k2 = ctx.normCmdKey("create_instance", { name: "Crate", className: "Part" });
    assert(k1 === k2, "key order irrelevant");
    assert(ctx.normCmdKey("delete_instance", { path: "x" }) !== k1, "different tool differs");
    assert(ctx.normCmdKey("get_time", null).startsWith("get_time|"), "null args safe");
  });

  await run("rememberExecuted caps the map", async () => {
    const ctx = loadHelpers();
    for (let i = 0; i < 350; i++) ctx.rememberExecuted("tool_" + i, {});
    assert(ctx.A.executedCmds.size <= 300, `capped, got ${ctx.A.executedCmds.size}`);
    assert(ctx.A.executedCmds.has(ctx.normCmdKey("tool_349", {})), "newest kept");
  });

  await run("historyHasSettled: result after call means settled", async () => {
    const key = "x";
    const ctx = loadHelpers([
      { role: "tool_call", name: "get_time", args: {} },
      { role: "tool_result", name: "get_time", ok: true, text: "t" },
    ]);
    void key;
    const k = ctx.normCmdKey("get_time", {});
    assert(ctx.historyHasSettled("get_time", k) === true, "settled");
  });

  await run("historyHasSettled: lone call means in-flight", async () => {
    const ctx = loadHelpers([{ role: "tool_call", name: "create_instance", args: { a: 1 } }]);
    const k = ctx.normCmdKey("create_instance", { a: 1 });
    assert(ctx.historyHasSettled("create_instance", k) === false, "not settled");
    assert(ctx.historyHasSettled("other_tool", k) === false, "other tool unaffected");
  });

  await run("watchdog block has every guard", async () => {
    for (const needle of [
      "missed-turn watchdog", "WATCHDOG_FRESH_MS", "A.running || A.starting || A.injecting",
      "A.stopping || A.userStopped", "P.isGenerating && P.isGenerating()",
      "P.conversationKey", "A.loopKey", "lastAssistantIdAtBoot",
      "turnHalted", "INJECTED_RE", "hasToolSignature", "hasOpenToolBlock",
      "extractAll", "normCmdKey", "historyHasSettled", "rlResume",
      "rememberExecuted", "watchdog.resume", "agentLoop(P.assistantCount",
    ]) assert(mainSrc.includes(needle), `main.js watchdog contains ${needle}`);
  });

  await run("dispatch remembers + re-anchors wiped chips", async () => {
    assert(mainSrc.includes("rememberExecuted(name, args);"), "dispatch remembers");
    assert(mainSrc.includes("chip.reanchor"), "re-anchor diag");
    assert(mainSrc.includes("!chip.isConnected && sourceItem"), "detach check");
    assert(mainSrc.includes("P.findToolBlockSpot(sourceItem, chip)"), "re-anchor via spot finder");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
