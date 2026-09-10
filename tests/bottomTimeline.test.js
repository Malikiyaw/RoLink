// SPDX-License-Identifier: GPL-3.0-or-later
// tests/bottomTimeline.test.js — P2 Bottom Timeline regression suite.
// Run with: node tests/bottomTimeline.test.js   (no deps)

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.join(__dirname, "..", "rolink-extension");
let passed = 0, failed = 0;
function assert(c, m) { if (!c) throw new Error("ASSERT FAILED: " + m); }
function ok(n) { console.log(`✓ ${n}`); passed++; }
function fail(n, e) { console.error(`✗ ${n}: ${e && e.message}`); failed++; }
async function run(n, fn) { try { await fn(); ok(n); } catch (e) { fail(n, e); } }

function loadTimeline() {
  // No `document`: boot() skipped, pure helpers + guards testable.
  const ctx = { window: {}, console, setTimeout, clearTimeout };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  ctx.module = { exports: {} };
  vm.createContext(ctx);
  for (const f of ["core/code-fields.js", "core/config.js", "core/tool-events.js"]) {
    vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx);
  }
  vm.runInContext(fs.readFileSync(path.join(EXT, "ui/toolHud/toolRegistry.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, "ui/toolHud/bottomTimeline.js"), "utf8"), ctx);
  return ctx;
}

(async () => {
  const src = fs.readFileSync(path.join(EXT, "ui/toolHud/bottomTimeline.js"), "utf8");
  const css = fs.readFileSync(path.join(EXT, "overlay.css"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const mainSrc = fs.readFileSync(path.join(EXT, "core/main.js"), "utf8");

  await run("orderEvents sorts oldest first", async () => {
    const ctx = loadTimeline();
    const ord = ctx.RolinkTimeline.orderEvents([
      { id: "c", startTime: 300 }, { id: "a", startTime: 100 }, { id: "b", startTime: 200 },
    ]);
    assert(ord.map((e) => e.id).join("") === "abc", "chronological");
    assert(ord.length === 3, "no drops");
  });

  await run("blockWidth scales with duration", async () => {
    const ctx = loadTimeline();
    const w = ctx.RolinkTimeline.blockWidth;
    assert(w({ status: "success", durationMs: 0 }, 10000) === 44, "zero duration = min width");
    assert(w({ status: "success", durationMs: 10000 }, 10000) === 160, "max duration = max width");
    const mid = w({ status: "success", durationMs: 5000 }, 10000);
    assert(mid > 44 && mid < 160, `mid scales (${mid})`);
    assert(w({ status: "running" }, 10000) === 64, "running fixed width");
    assert(w({ status: "queued" }, 10000) === 64, "queued fixed width");
    assert(w({ status: "success" }, 0) >= 44, "zero max safe");
  });

  await run("summarizeArgs truncates pairs", async () => {
    const ctx = loadTimeline();
    const s = ctx.RolinkTimeline.summarizeArgs;
    assert(s({}) === "", "empty safe");
    assert(s(null) === "", "null safe");
    const one = s({ className: "Part", parent: "workspace" });
    assert(one.includes("className: Part"), "pair rendered");
    const many = s({ a: 1, b: 2, c: 3, d: 4 }, 3);
    assert(!many.includes("d:"), "capped at maxPairs");
    const long = s({ code: "x".repeat(200) });
    assert(long.includes("…") && long.length < 100, "long value ellipsized");
  });

  await run("mount guards without DOM, unmount/toggle safe", async () => {
    const ctx = loadTimeline();
    const api = ctx.RolinkTimeline;
    assert(api.mount() === false, "mount false with no document");
    assert(api.isOpen() === false, "not open");
    api.unmount();
    api.toggle(true);
    await api.replayAll(); // no ROLINK → resolves, never throws
  });

  await run("replayOne guards: no session, no fn", async () => {
    const ctx = loadTimeline();
    // No window.ROLINK at all: replayAll resolves without throwing.
    await ctx.RolinkTimeline.replayAll();
    // ROLINK present but session not started: still resolves.
    ctx.ROLINK = { status: () => ({ started: false, running: false }) };
    await ctx.RolinkTimeline.replayAll();
  });

  await run("source: bus + replay + tooltip + follow", async () => {
    for (const needle of [
      "RolinkToolEvents", "subscribe", "replayTool", "replayAll", "REPLAY_GAP_MS",
      "rl-tl-tip", "summarizeArgs", "setFollow", "MAX_BLOCKS", "chrome.storage.local",
      "sessionStarted", "isReplaying",
    ]) assert(src.includes(needle), `bottomTimeline.js contains ${needle}`);
  });

  await run("css: filmstrip + running stripes + light mode", async () => {
    for (const needle of [
      ".rl-timeline", ".rl-tl-film", ".rl-tl-block", ".rl-tl-tip", ".rl-tl-toast",
      "rl-tl-slide", "prefers-reduced-motion", "html.rl-light .rl-timeline",
      ".rl-tl-replay",
    ]) assert(css.includes(needle), `overlay.css contains ${needle}`);
  });

  await run("manifest: bottomTimeline.js after sideDock in all 8", async () => {
    const entries = manifest.content_scripts.filter((c) => (c.world || "ISOLATED") === "ISOLATED");
    assert(entries.length === 8, `8 isolated entries, got ${entries.length}`);
    for (const c of entries) {
      const iDock = c.js.indexOf("ui/toolHud/sideDock.js");
      const iTl = c.js.indexOf("ui/toolHud/bottomTimeline.js");
      const iParser = c.js.indexOf("core/parser.js");
      assert(iDock >= 0 && iTl > iDock && iTl < iParser, `order dock<timeline<parser in ${c.matches}`);
    }
  });

  await run("main.js: replayTool exposed + timeline button wired", async () => {
    assert(mainSrc.includes("replayTool"), "replayTool present");
    assert(mainSrc.includes("dispatchTool(name, safeArgs, null, null, null)"), "replay via canonical dispatch");
    assert(mainSrc.includes('id="rl-tl-btn"'), "timeline bar button present");
    assert(mainSrc.includes("RolinkTimeline"), "toggle wiring present");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
