// SPDX-License-Identifier: GPL-3.0-or-later
// tests/settle-events.test.js - Block-stable settle + end-to-end event identity.
//
// Failure mode (Arena Agent Mode): the model emits a complete tool block, but
// the turn never settles — a ticking thought-timer mutates the observed reply
// text so text-stability never holds, and perpetual busy UI holds the gen gate
// open. Result: zero dispatches ("· 0 tools") while the model waits forever.
// Companion display bug: parser "queued" rows could never resolve because
// execution minted an unrelated id per call.
//
// Pins:
//   1. ZSParse.stableBlockKey: complete payload bytes, "" when incomplete/absent,
//      identical across texts that differ only outside the block.
//   2. Parser stamps the bus event id onto the normalized call (.eventId) and
//      the bus row carries the same id (correlation basis for Timeline/Dock).
//   3. ToolExecutionManager prefers call.id (threading) and still mints when
//      absent; the bg request carries the threaded id.
//   4. Dock/Timeline expose clearView (fresh-session reset); main.js wires
//      blockSettled + c.eventId + clearView + volatile stripping.
//
// Run: node tests/settle-events.test.js   (no deps)

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.join(__dirname, "..", "rolink-extension");
let passed = 0, failed = 0;
async function run(name, fn) {
  try { await fn(); console.log("✓", name); passed++; }
  catch (e) { console.error("✗", name, "ASSERT FAILED:", e && e.message || ""); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const BLOCK = '###MCP_TOOL###\n{"tool":"get_studio_state","args":{}}';
const withChrome = (timer) =>
  `Thought for ${timer}\n${BLOCK}\nAgent working…`;

(async () => {
  // ── 1: stableBlockKey ───────────────────────────────────────────
  const parser = require(path.join(EXT, "core", "parser.js"));
  assert(typeof parser.stableBlockKey === "function", "stableBlockKey exported");

  await run("complete block -> payload bytes", async () => {
    const k = parser.stableBlockKey(BLOCK);
    assert(k === '{"tool":"get_studio_state","args":{}}', "exact payload, got: " + k);
  });

  await run("incomplete / absent block -> empty", async () => {
    assert(parser.stableBlockKey("###MCP_TOOL###\n{\"tool\":\"get_studio") === "", "cut-off empty");
    assert(parser.stableBlockKey("Yo! How can I help?") === "", "prose empty");
    assert(parser.stableBlockKey("") === "", "empty empty");
    assert(parser.stableBlockKey(null) === "", "null safe");
  });

  await run("same payload under churning chrome -> same key", async () => {
    // The thought-timer ticks every second; the payload must not move.
    assert(parser.stableBlockKey(withChrome("1 minute and 37 seconds"))
        === parser.stableBlockKey(withChrome("1 minute and 38 seconds")),
      "timer churn invisible to key");
  });

  await run("changed payload -> changed key", async () => {
    const other = BLOCK.replace("get_studio_state", "get_instances");
    assert(parser.stableBlockKey(BLOCK) !== parser.stableBlockKey(other), "payload change detected");
  });

  // ── 2: parser stamps bus id ─────────────────────────────────────
  await run("extractAll stamps eventId matching the queued bus row", async () => {
    const bus = require(path.join(EXT, "core", "tool-events.js"));
    bus.clear();
    global.window = { RolinkToolEvents: bus, ToolEventBus: bus };
    try {
      delete require.cache[require.resolve(path.join(EXT, "core", "parser.js"))];
      const p2 = require(path.join(EXT, "core", "parser.js"));
      const calls = p2.extractAll(BLOCK);
      assert(calls.length === 1 && calls[0].tool === "get_studio_state", "one call parsed");
      assert(typeof calls[0].eventId === "string" && calls[0].eventId.length > 0, "eventId stamped");
      const rows = bus.recent(5).filter((e) => e.status === "queued" && e.tool === "get_studio_state");
      assert(rows.length >= 1, "queued row published");
      assert(rows.some((e) => e.id === calls[0].eventId), "row id === call eventId");
    } finally { delete global.window; }
  });

  // ── 3: execution threads call.id ────────────────────────────────
  await run("execute prefers call.id for bg correlation + result", async () => {
    global.document = { hidden: false };
    global.window = {};
    try {
      const { ToolExecutionManager } = require(path.join(EXT, "core", "execution.js"));
      let seenId = null;
      const bg = (msg) => { seenId = msg.id; return Promise.resolve({ ok: true, text: "studio-ok", images: [] }); };
      const mgr = new ToolExecutionManager({ bg });
      const res = await mgr.execute(
        { name: "get_studio_state", arguments: {}, id: "rl_threaded123" }, { timeout: 5000 });
      assert(res.ok === true && res.id === "rl_threaded123", "result keeps threaded id");
      assert(seenId === "rl_threaded123", "bg request carries threaded id");
      const res2 = await mgr.execute({ name: "get_time", arguments: {} }, { timeout: 5000 });
      assert(/^rl_/.test(res2.id) && res2.id !== "rl_threaded123", "absent id still minted");
    } finally { delete global.document; delete global.window; }
  });

  // ── 4: HUD reset + wiring contracts ─────────────────────────────
  function loadVm(file, extra) {
    const ctx = Object.assign({ window: {}, console, setTimeout, clearTimeout }, extra || {});
    ctx.globalThis = ctx; ctx.window = ctx; ctx.module = { exports: {} };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(file, "utf8"), ctx);
    return ctx;
  }

  await run("dock + timeline expose clearView", async () => {
    for (const f of ["ui/toolHud/sideDock.js", "ui/toolHud/bottomTimeline.js"]) {
      const ctx = loadVm(path.join(EXT, f));
      const api = ctx.RolinkSideDock || ctx.RolinkTimeline;
      assert(api && typeof api.clearView === "function", f + " exports clearView");
    }
  });

  await run("main.js wires settle + identity + reset", async () => {
    const src = fs.readFileSync(path.join(EXT, "core", "main.js"), "utf8");
    for (const needle of [
      "stableBlockKey", "blockSettled", "lastBlockKey", "blockStableSince",
      "c.eventId", "id: eventId", "clearView",
    ]) assert(src.includes(needle), "main.js contains: " + needle);
  });

  await run("generic + arena expose volatile stripping", async () => {
    const gen = fs.readFileSync(path.join(EXT, "providers", "generic.js"), "utf8");
    const arena = fs.readFileSync(path.join(EXT, "providers", "arena.js"), "utf8");
    assert(gen.includes("volatileSel") && gen.includes("stripVolatile"), "generic mechanism");
    assert(arena.includes("volatileSel") && arena.includes("stripVolatile"),
      "arena list + step-path stripping");
    assert(/thought/i.test(arena.split("volatileSel")[1].slice(0, 400)), "thought nodes covered");
  });

  console.log(`\nSettle/events tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
