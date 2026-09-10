// SPDX-License-Identifier: GPL-3.0-or-later
// tests/tool-events.test.js — P0 ToolEvent spine regression suite.
// Run with: node tests/tool-events.test.js   (no deps)
//
// Covers:
//   1. Bus publish/subscribe + 50-event ring cap
//   2. All 111 registry tools map to a valid category (extended toolCategory)
//   3. toolRegistry has 111 entries with color+icon+preview
//   4. Parser emits a "queued" event on extract
//   5. ToolExecutionManager emits running -> success lifecycle

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const CORE = path.join(__dirname, "..", "rolink-extension", "core");
const UI = path.join(__dirname, "..", "rolink-extension", "ui", "toolHud");

function loadBus() {
  const files = ["config.js", "tool-events.js", "parser.js", "execution.js"].map(
    (f) => fs.readFileSync(path.join(CORE, f), "utf8")
  );
  const registrySrc = fs.readFileSync(path.join(UI, "toolRegistry.js"), "utf8");
  const codeFields = fs.readFileSync(path.join(CORE, "code-fields.js"), "utf8");
  const ctx = {
    window: {},
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  ctx.globalThis = ctx;
  ctx.window = ctx; // content-script globals land on window
  vm.createContext(ctx);
  vm.runInContext(codeFields + "\n" + files[0], ctx); // code-fields + config
  vm.runInContext(files[1], ctx); // tool-events
  vm.runInContext(registrySrc, ctx); // toolRegistry
  vm.runInContext(files[2], ctx); // parser
  vm.runInContext(files[3], ctx); // execution
  return ctx;
}

const VALID_CATS = ["read", "edit", "inspect", "generate", "asset", "visual", "test", "tool"];
let passed = 0, failed = 0;
function assert(c, m) { if (!c) throw new Error("ASSERT FAILED: " + m); }
function ok(n) { console.log(`✓ ${n}`); passed++; }
function fail(n, e) { console.error(`✗ ${n}: ${e && e.message}`); failed++; }
async function run(n, fn) { try { await fn(); ok(n); } catch (e) { fail(n, e); } }

(async () => {
  const ctx = loadBus();
  const bus = ctx.RolinkToolEvents || ctx.ToolEventBus;
  const reg = ctx.ROLINK_TOOL_REGISTRY;
  const ZSParse = ctx.ZSParse;
  const registryNames = JSON.parse(
    fs.readFileSync(path.join(__dirname, "__registry__.json"), "utf8")
  );

  await run("bus loads with publish/subscribe/recent", async () => {
    assert(bus && typeof bus.publish === "function", "publish exists");
    assert(typeof bus.subscribe === "function", "subscribe exists");
    assert(bus.MAX_RING === 50, "ring cap 50");
  });

  await run("publish/subscribe round-trip with lifecycle fields", async () => {
    bus.clear();
    let seen = null;
    const unsub = bus.subscribe((ev) => { seen = ev; });
    const ev = bus.publish({ tool: "create_instance", args: { className: "Part" }, status: "running" });
    assert(ev && ev.id && ev.tool === "create_instance", "event has id+tool");
    assert(ev.category === "edit", `category edit, got ${ev.category}`);
    assert(ev.status === "running", "status running");
    assert(ev.startTime > 0, "startTime set");
    assert(seen && seen.id === ev.id, "subscriber got event");
    unsub();
  });

  await run("ring buffer caps at 50", async () => {
    bus.clear();
    for (let i = 0; i < 60; i++) bus.publish({ tool: "get_time", args: {}, status: "queued" });
    assert(bus.recent().length === 50, `ring 50, got ${bus.recent().length}`);
    assert(bus.recent(5).length === 5, "recent(5) works");
  });

  await run("all 111 registry tools map to a valid category", async () => {
    assert(registryNames.length === 111, `111 names, got ${registryNames.length}`);
    const bad = registryNames.filter((n) => !VALID_CATS.includes(bus.categoryOf(n)));
    assert(bad.length === 0, `uncategorized: ${bad.join(",")}`);
  });

  await run("toolRegistry has 111 entries with color+icon+preview", async () => {
    assert(reg && reg.TOOL_COUNT === 111, `111 entries, got ${reg && reg.TOOL_COUNT}`);
    for (const n of registryNames) {
      const e = reg.registry[n];
      assert(e, `entry ${n}`);
      assert(e.color && e.icon && e.preview, `${n} has style`);
      assert(VALID_CATS.includes(e.category), `${n} valid cat`);
    }
  });

  await run("parser emits queued event on extract", async () => {
    bus.clear();
    const r = ZSParse.extract('###MCP_TOOL###\n{"tool":"create_instance","args":{"className":"Part"}}');
    assert(r && r.tool === "create_instance", "parsed");
    const evts = bus.recent();
    assert(evts.length >= 1 && evts[evts.length - 1].tool === "create_instance", "queued emitted");
    assert(evts[evts.length - 1].status === "queued", "status queued");
  });

  await run("execution emits running -> success", async () => {
    bus.clear();
    const Mgr = ctx.ToolExecutionManager;
    assert(typeof Mgr === "function", "manager loaded");
    const seen = [];
    bus.subscribe((ev) => seen.push(ev.status + ":" + ev.tool));
    const mgr = new Mgr({
      bg: () => Promise.resolve({ ok: true, text: "done", images: [] }),
      diag: () => {},
    });
    const res = await mgr.execute(
      { name: "get_time", arguments: {} },
      { sessionId: "s1", turnId: "t1", timeout: 5000 }
    );
    assert(res.ok === true, "exec ok");
    assert(seen.includes("running:get_time"), `running seen: ${seen.join(",")}`);
    assert(seen.includes("success:get_time"), `success seen: ${seen.join(",")}`);
    const last = bus.recent()[bus.recent().length - 1];
    assert(last.id === res.id, "terminal event reuses execution id");
    assert(typeof last.durationMs === "number", "durationMs set");
  });

  await run("execution emits error on bridge_offline", async () => {
    bus.clear();
    const Mgr = ctx.ToolExecutionManager;
    const seen = [];
    bus.subscribe((ev) => seen.push(ev.status + ":" + ev.tool));
    const mgr = new Mgr({
      bg: () => Promise.resolve({ ok: false, kind: "bridge_offline", error: "bridge not connected" }),
      diag: () => {},
    });
    const res = await mgr.execute({ name: "get_time", arguments: {} }, { timeout: 5000 });
    assert(res.ok === false, "exec fails");
    assert(seen.includes("error:get_time"), `error seen: ${seen.join(",")}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
