// SPDX-License-Identifier: GPL-3.0-or-later
// tests/sideDock.test.js — P1 Side Dock regression suite.
// Run with: node tests/sideDock.test.js   (no deps)

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.join(__dirname, "..", "rolink-extension");
let passed = 0, failed = 0;
function assert(c, m) { if (!c) throw new Error("ASSERT FAILED: " + m); }
function ok(n) { console.log(`✓ ${n}`); passed++; }
function fail(n, e) { console.error(`✗ ${n}: ${e && e.message}`); failed++; }
async function run(n, fn) { try { await fn(); ok(n); } catch (e) { fail(n, e); } }

function loadSideDock() {
  // No `document` in sandbox: boot() is skipped, pure helpers + guards testable.
  const ctx = { window: {}, console, setTimeout, clearTimeout };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  ctx.module = { exports: {} };
  vm.createContext(ctx);
  for (const f of ["core/code-fields.js", "core/config.js", "core/tool-events.js"]) {
    vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx);
  }
  vm.runInContext(fs.readFileSync(path.join(EXT, "ui/toolHud/toolRegistry.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, "ui/toolHud/sideDock.js"), "utf8"), ctx);
  return ctx;
}

(async () => {
  const src = fs.readFileSync(path.join(EXT, "ui/toolHud/sideDock.js"), "utf8");
  const css = fs.readFileSync(path.join(EXT, "overlay.css"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const mainSrc = fs.readFileSync(path.join(EXT, "core/main.js"), "utf8");

  await run("statusClass maps all P0 statuses", async () => {
    const ctx = loadSideDock();
    const api = ctx.RolinkSideDock;
    assert(api.statusClass("queued") === "q", "queued");
    assert(api.statusClass("running") === "run", "running");
    assert(api.statusClass("success") === "ok", "success");
    assert(api.statusClass("error") === "err", "error");
    assert(api.statusClass("timeout") === "tmo", "timeout");
    assert(api.statusClass("cancelled") === "can", "cancelled");
    assert(api.statusClass("stale") === "stale", "stale");
    assert(api.statusClass("bogus") === "q", "unknown falls back");
  });

  await run("formatDuration humanizes ms/s/m", async () => {
    const ctx = loadSideDock();
    const f = ctx.RolinkSideDock.formatDuration;
    assert(f(250) === "250ms", "ms");
    assert(f(1500) === "1.5s", "seconds");
    assert(f(90000) === "1m 30s", "minutes");
    assert(f(null) === "", "null safe");
  });

  await run("fuzzyMatch subsequence + empty query", async () => {
    const ctx = loadSideDock();
    const m = ctx.RolinkSideDock.fuzzyMatch;
    assert(m("gm", "generate_mesh") === true, "subsequence");
    assert(m("mesh", "generate_mesh") === true, "substring");
    assert(m("xyz", "generate_mesh") === false, "no match");
    assert(m("", "anything") === true, "empty matches all");
  });

  await run("filterTools covers 113, substring first", async () => {
    const ctx = loadSideDock();
    const api = ctx.RolinkSideDock;
    assert(api.filterTools("").length === 113, "empty query returns 113");
    const hits = api.filterTools("asset");
    assert(hits.includes("generate_asset"), "asset hit");
    assert(hits[0] === "search_asset", "registry-order substring hit ranks first");
    assert(api.filterTools("zzz-no-such-tool").length === 0, "no false positives");
    const fuzzy = api.filterTools("gnasset");
    assert(fuzzy.includes("generate_asset"), "fuzzy fallback finds it");
  });

  await run("mount guards without DOM, unmount safe", async () => {
    const ctx = loadSideDock();
    const api = ctx.RolinkSideDock;
    assert(api.mount() === false, "mount false with no document");
    assert(api.isOpen() === false, "not open");
    api.unmount(); // must not throw
    api.toggle(true); // must not throw without DOM
  });

  await run("source: bus subscribe + palette + confetti + guards", async () => {
    for (const needle of [
      "RolinkToolEvents", "subscribe", "Ctrl+K", "openPalette", "closePalette",
      "confettiBurst", "rl-dock-shake", "prefers-reduced-motion", "MAX_ROWS",
      "chrome.storage.local", "TERMINAL",
    ]) assert(src.includes(needle), `sideDock.js contains ${needle}`);
  });

  await run("source: dock renders args/result/diff/preview", async () => {
    for (const needle of [
      "rl-dock-list", "rl-dock-row-body", "codeDiff", "previewUrl",
      "rl-dock-diff", "rl-dock-thumb", "data-search", "--cat",
    ]) assert(src.includes(needle), `sideDock.js contains ${needle}`);
  });

  await run("css: dock glassmorphism + motion + light mode", async () => {
    for (const needle of [
      ".rl-dock", ".rl-dock-tab", ".rl-dock-pal-ov", "backdrop-filter: blur(20px)",
      "rl-dock-pulse", "rl-dock-shake", "rl-dock-in", "prefers-reduced-motion",
      "html.rl-light .rl-dock", ".rl-dock-confetti",
    ]) assert(css.includes(needle), `overlay.css contains ${needle}`);
  });

  await run("manifest: sideDock.js in all 8 content scripts", async () => {
    const entries = manifest.content_scripts.filter((c) => (c.world || "ISOLATED") === "ISOLATED");
    assert(entries.length === 8, `8 isolated entries, got ${entries.length}`);
    for (const c of entries) {
      assert(c.js.includes("ui/toolHud/sideDock.js"), `sideDock in ${c.matches}`);
      const iCfg = c.js.indexOf("core/config.js");
      const iBus = c.js.indexOf("core/tool-events.js");
      const iReg = c.js.indexOf("ui/toolHud/toolRegistry.js");
      const iDock = c.js.indexOf("ui/toolHud/sideDock.js");
      const iMain = c.js.indexOf("core/main.js");
      assert(iCfg < iBus && iBus < iReg && iReg < iDock && iDock < iMain, "load order config<bus<registry<dock<main");
    }
  });

  await run("main.js: dock toggle button wired", async () => {
    assert(mainSrc.includes('id="rl-dock-btn"'), "bar button present");
    assert(mainSrc.includes("RolinkSideDock"), "toggle wiring present");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
