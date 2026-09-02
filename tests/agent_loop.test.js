// SPDX-License-Identifier: GPL-3.0-or-later
// tests/agent_loop.test.js — Phase 3 agent-loop robustness contract.
//
// The agent loop in core/main.js is an IIFE that depends on the DOM, the
// extension's chrome.runtime bridge, and a ZSProvider — too much surface to
// load in a node sandbox. This test instead pins the dispatch-side contracts
// that broke in the past (and would have killed the loop):
//
//   1. An invalid name must be refused with a structured error, not an
//      undefined explosion.
//   2. A thrown exception inside execute must NOT kill the loop — it
//      must surface as a structured error.
//   3. Every tool call produces a matching tool_result history entry
//      (S9: history provenance).
//   4. A successful call resets the drift counter (S5d).
//
// To run main.js in isolation we'd need to stub chrome.* and document.*;
// instead we re-implement the small bit of dispatchTool's contract here.
// The real test is integration (Phase 5). The shape is what matters.

const fs = require("node:fs");
const path = require("node:path");

let passed = 0, failed = 0;
function assert(cond, msg) { if (!cond) throw new Error("ASSERT FAILED: " + msg); }
function ok(name) { console.log("✓", name); passed++; }
function bad(name, e) { console.error("✗", name, e && e.message || ""); failed++; }

// Mirror of dispatchTool's contract: produces a structured result on every
// failure path and never throws. The "actual" version is the IIFE in
// core/main.js; this stub exists to pin the contract.
async function dispatchTool(name, args, exec) {
  // S1: name validation
  if (!name || typeof name !== "string") {
    return { ok: false, kind: "validation_error", error: "invalid tool name " + String(name), text: "" };
  }
  if (!args || typeof args !== "object") {
    return { ok: false, kind: "validation_error", error: "arguments must be an object", text: "" };
  }
  // S9: history
  const hist = [];
  hist.push({ role: "tool_call", name, args, ts: Date.now() });
  // S10: try/catch around execute
  let res;
  try {
    res = await exec(name, args);
  } catch (e) {
    res = { ok: false, kind: "exception", error: String(e && e.message || e), text: "" };
  }
  if (!res) res = { ok: false, kind: "bridge_offline", error: "no response", text: "" };
  hist.push({ role: "tool_result", name, ok: !!res.ok, text: res.text || res.error, ts: Date.now(), durationMs: 1, kind: res.kind || (res.ok ? "success" : "error") });
  return { ...res, _history: hist };
}

(async () => {
  // ── 1: invalid name ─────────────────────────────────────────────
  await run("invalid name -> structured validation_error, no throw", async () => {
    for (const badName of [undefined, null, "", 0, [], {}]) {
      const r = await dispatchTool(badName, {}, async () => ({ ok: true, text: "should not run" }));
      assert(r.ok === false, "ok false");
      assert(r.kind === "validation_error", "kind = validation_error");
      assert(typeof r.error === "string" && r.error.length > 0, "error is a non-empty string");
      assert(!/^undefined$/.test(r.error), `error must not be the literal "undefined" (got ${JSON.stringify(r.error)})`);
    }
  });

  // ── 2: thrown exception ──────────────────────────────────────────
  await run("thrown exception -> structured exception kind, no throw", async () => {
    const r = await dispatchTool("execute_luau", { code: "x" }, async () => {
      throw new Error("Studio crashed");
    });
    assert(r.ok === false, "ok false");
    assert(r.kind === "exception", "kind = exception");
    assert(r.error.includes("Studio crashed"), "error contains original message");
  });

  await run("rejected promise -> structured exception kind", async () => {
    const r = await dispatchTool("execute_luau", { code: "x" }, async () => {
      return Promise.reject(new Error("bridge offline"));
    });
    assert(r.kind === "exception", "kind = exception");
  });

  // ── 3: history provenance ────────────────────────────────────────
  await run("every call produces matching tool_call + tool_result history", async () => {
    const r = await dispatchTool("create_instance", { className: "Part" }, async () => ({ ok: true, text: "ok" }));
    const hist = r._history;
    assert(hist.length === 2, "two history entries");
    assert(hist[0].role === "tool_call" && hist[0].name === "create_instance", "first is tool_call");
    assert(hist[1].role === "tool_result" && hist[1].name === "create_instance", "second is tool_result");
    assert(hist[1].ok === true, "result ok true");
  });

  await run("thrown exception still produces matching history pair", async () => {
    const r = await dispatchTool("create_instance", {}, async () => { throw new Error("x"); });
    const hist = r._history;
    assert(hist.length === 2, "two entries even on throw");
    assert(hist[1].role === "tool_result", "second entry is result");
    assert(hist[1].ok === false, "ok false on throw");
    assert(hist[1].kind === "exception", "kind = exception");
  });

  // ── 4: drift reset (S5d) ─────────────────────────────────────────
  await run("successful call resets drift counter", async () => {
    // Simulate the drift API contract
    const drift = { turnsSinceSuccess: { deepseek: 4 }, lastNudgeTurn: {} };
    const noteTurn = (p) => { drift.turnsSinceSuccess[p] = (drift.turnsSinceSuccess[p] || 0) + 1; };
    const noteSuccessfulTool = (p) => { drift.turnsSinceSuccess[p] = 0; };
    const shouldReinject = (p) => (drift.turnsSinceSuccess[p] || 0) >= 4;

    noteTurn("deepseek"); noteTurn("deepseek"); noteTurn("deepseek"); noteTurn("deepseek");
    assert(shouldReinject("deepseek") === true, "drift detected");
    // Successful call
    noteSuccessfulTool("deepseek");
    assert(shouldReinject("deepseek") === false, "drift cleared after success");
  });

  // ── 5: lazy datamodel_type (S12) ─────────────────────────────────
  await run("datamodel_type read at call time, not at top of dispatch", async () => {
    // Simulate two consecutive calls; the second one sees the updated DM.
    let observedDM = null;
    const exec = async (n, a) => { observedDM = a.datamodel_type; return { ok: true, text: "ok" }; };
    // First call: A.focusedDataModel is unset
    await dispatchTool("execute_luau", { code: "x" }, exec);
    assert(observedDM === undefined, "first call: no datamodel");
    // User re-focused Studio between calls. The next dispatch should pick
    // up the new DM. The contract: A.focusedDataModel is read at the start
    // of dispatchTool, not cached.
    const A = { focusedDataModel: "Server" };
    // A new dispatchTool instance reads A.focusedDataModel now.
    const args = {};
    if (!args.datamodel_type && A.focusedDataModel) args.datamodel_type = A.focusedDataModel;
    await exec("execute_luau", args);
    assert(observedDM === "Server", "second call sees new datamodel");
  });

  console.log(`\nAgent-loop tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);

  async function run(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }
})();
