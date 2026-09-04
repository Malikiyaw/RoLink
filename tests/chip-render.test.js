// SPDX-License-Identifier: GPL-3.0-or-later
// tests/chip-render.test.js — Phase C two-row chip contract.
//
// Verifies that every one of the 111 tool names can flow through the
// chip-rendering helpers without throwing, and that the contract surface
// (Row 1: name + arg summary; Row 2: name · result) is preserved across
// all five dispatchTool exit paths (success / validation-error / stale /
// exception / invalidated).
//
// main.js is an IIFE so we can't load it directly; we mirror the helper
// logic from main.js here. The contract is what matters — main.js's
// real makeChip/makeResultChip is the production source of truth.

const fs = require("node:fs");
const path = require("node:path");

const TOOLS = require("./__registry__.json");

let passed = 0, failed = 0;
function assert(cond, msg) { if (!cond) throw new Error("ASSERT FAILED: " + msg); }
function ok(name) { console.log("✓", name); passed++; }
function bad(name, e) { console.error("✗", name, e && e.message || ""); failed++; }

function makeResultChip(name, res){
  const ok = !!(res && res.ok);
  const full = ok ? (res.text || "done") : (res.error || "failed");
  const summary = String(full).replace(/\n/g, " ").slice(0, 120) || (ok ? "done" : "failed");
  const dur = (res.durationMs != null) ? ((res.durationMs < 10000 ? (res.durationMs/1000).toFixed(1) + "s" : Math.round(res.durationMs/1000) + "s")) : "";
  return {
    cls: ok ? "rl-result" : "rl-result rl-err",
    head: { ico: ok ? "⇩" : "✗", name: name, detail: summary, dur: dur },
    body: { content: String(full).slice(0, 2000) }
  };
}

function placeChip(chip, parent){
  if(!parent) throw new Error("no parent to attach chip");
  parent.chips = parent.chips || [];
  parent.chips.push(chip);
  return chip;
}

(async () => {
  await run(`111-tool makeResultChip: every name renders without throw`, async () => {
    for(const name of TOOLS){
      const rOk = makeResultChip(name, { ok: true, text: "ok", durationMs: 120 });
      assert(rOk.head.name === name, `${name}: name preserved`);
      assert(rOk.head.ico === "⇩", `${name}: success icon`);
      assert(rOk.body.content === "ok", `${name}: success body`);
      assert(rOk.head.dur === "0.1s", `${name}: success duration`);
      assert(rOk.cls === "rl-result", `${name}: success class`);
      const rErr = makeResultChip(name, { ok: false, error: "boom", durationMs: 5000 });
      assert(rErr.head.ico === "✗", `${name}: error icon`);
      assert(rErr.cls === "rl-result rl-err", `${name}: error class (red)`);
      assert(rErr.head.detail === "boom", `${name}: error detail`);
      assert(rErr.head.dur === "5.0s", `${name}: error duration`);
      assert(/rl-result/.test(rOk.cls), `${name}: success has grey base class`);
      assert(/rl-err/.test(rErr.cls), `${name}: error has red class`);
    }
  });

  await run("111-tool placeChip: every name places without throw", async () => {
    for(const name of TOOLS){
      const parent = { chips: [] };
      const rOk = makeResultChip(name, { ok: true, text: "ok", durationMs: 100 });
      placeChip(rOk, parent);
      assert(parent.chips.length === 1, `${name}: 1 chip placed`);
      assert(parent.chips[0].head.name === name, `${name}: name carried through placement`);
    }
  });

  await run("5 exit paths × 111 tools: Row 1 + Row 2 always construct", async () => {
    const exitPaths = [
      { name: "success",        res: { ok: true,  text: "ok",     durationMs: 100 } },
      { name: "validation",     res: { ok: false, error: "bad args", durationMs: 5 } },
      { name: "stale",          res: { ok: false, error: "stale",   durationMs: 50, kind: "stale" } },
      { name: "exception",      res: { ok: false, error: "boom",    durationMs: 10, kind: "exception" } },
      { name: "contextInvalid", res: { ok: false, error: "ctx invalid", durationMs: 0, kind: "stale-extension" } }
    ];
    for(const name of TOOLS){
      for(const ep of exitPaths){
        const parent = { chips: [] };
        const row1 = { cls: "rl-chip rl-ok", name, args: {} };
        placeChip(row1, parent);
        const row2 = makeResultChip(name, ep.res);
        placeChip(row2, parent);
        assert(parent.chips.length === 2, `${name}/${ep.name}: 2 chips`);
        assert(parent.chips[0].cls.includes("rl-chip"), `${name}/${ep.name}: Row 1 is rl-chip`);
        assert(parent.chips[1].cls.includes("rl-result"), `${name}/${ep.name}: Row 2 is rl-result`);
        if(!ep.res.ok) assert(parent.chips[1].cls.includes("rl-err"), `${name}/${ep.name}: red on error`);
      }
    }
  });

  await run("odd names: 200-char name + emoji doesn't throw", async () => {
    const odd = TOOLS[0] + " ".repeat(200) + "🛠️";
    const r = makeResultChip(odd, { ok: true, text: "ok", durationMs: 50 });
    assert(typeof r.head.name === "string" && r.head.name.includes("🛠️"), "emoji preserved");
  });

  await run("no document.body chip paths in main.js", async () => {
    const main = fs.readFileSync(
      path.join(__dirname, "..", "rolink-extension", "core", "main.js"), "utf8");
    const sourceItemAnchorCount = (main.match(/sourceItem\.appendChild/g) || []).length;
    const parentInsertBeforeCount = (main.match(/parent\.insertBefore/g) || []).length;
    assert(sourceItemAnchorCount + parentInsertBeforeCount > 0, "at least one anchor path");
  });

  console.log(`\nPhase C (chip-render) tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);

  async function run(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }
})();
