// SPDX-License-Identifier: GPL-3.0-or-later
// tests/studioHud.test.js — P3 Studio hologram HUD regression suite.
// Run with: node tests/studioHud.test.js   (no deps)
//
// Covers the Luau side (no Studio here, so source contracts + a strong
// cross-parity check: the Luau 111-tool category table must agree with the
// extension's toolCategory() for every registered tool).

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "rolink-extension");
const PLUGIN = path.join(ROOT, "studio-plugin");
let passed = 0, failed = 0;
function assert(c, m) { if (!c) throw new Error("ASSERT FAILED: " + m); }
function ok(n) { console.log(`✓ ${n}`); passed++; }
function fail(n, e) { console.error(`✗ ${n}: ${e && e.message}`); failed++; }
async function run(n, fn) { try { await fn(); ok(n); } catch (e) { fail(n, e); } }

function loadExtensionCats() {
  const ctx = { window: {}, console, setTimeout, clearTimeout };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ["core/code-fields.js", "core/config.js", "core/tool-events.js"]) {
    vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx);
  }
  return ctx.RolinkToolEvents.categoryOf;
}

// Parse `name = "category",` pairs out of a Luau table literal.
function parseLuauMap(src, tableName) {
  const start = src.indexOf(tableName);
  assert(start >= 0, `${tableName} found`);
  // Skip the Luau type annotation (`: { [string]: string }`) — the literal
  // starts at the `= {` that follows the declaration.
  const eq = src.indexOf("= {", start);
  assert(eq > start, `${tableName} literal found`);
  const open = src.indexOf("{", eq);
  // Balance-brace scan from the opening brace.
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  assert(end > open, `${tableName} closes`);
  const body = src.slice(open, end);
  const map = {};
  const re = /([A-Za-z0-9_]+)\s*=\s*"([a-z]+)"/g;
  let m;
  while ((m = re.exec(body))) map[m[1]] = m[2];
  return map;
}

(async () => {
  const module = fs.readFileSync(path.join(PLUGIN, "src", "toolVisualizer.luau"), "utf8");
  const rolua = fs.readFileSync(path.join(PLUGIN, "RoLink.lua"), "utf8");
  const rojo = fs.readFileSync(path.join(PLUGIN, "src", "plugin", "init.plugin.luau"), "utf8");
  const queue = fs.readFileSync(path.join(ROOT, "mcp-server", "src", "commandQueue.ts"), "utf8");
  const index = fs.readFileSync(path.join(ROOT, "mcp-server", "src", "index.ts"), "utf8");
  const proto = fs.readFileSync(path.join(ROOT, "shared", "protocol.ts"), "utf8");
  const registryNames = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "__registry__.json"), "utf8"));
  const VALID = ["read", "edit", "inspect", "generate", "asset", "visual", "test", "tool"];

  await run("module: full 113-tool map, valid categories", async () => {
    const map = parseLuauMap(module, "TOOL_CATEGORY");
    assert(Object.keys(map).length === 113, `113 entries, got ${Object.keys(map).length}`);
    for (const n of registryNames) {
      assert(map[n], `module maps ${n}`);
      assert(VALID.includes(map[n]), `${n} valid category`);
    }
  });

  await run("module map agrees with extension toolCategory() on all 113", async () => {
    const jsCat = loadExtensionCats();
    const map = parseLuauMap(module, "TOOL_CATEGORY");
    const diff = registryNames.filter((n) => map[n] !== jsCat(n));
    assert(diff.length === 0, `parity mismatches: ${diff.join(",")}`);
  });

  await run("RoLink.lua embed agrees with extension on all 113", async () => {
    const jsCat = loadExtensionCats();
    const map = parseLuauMap(rolua, "VCatExact");
    assert(Object.keys(map).length === 113, `113 entries, got ${Object.keys(map).length}`);
    const diff = registryNames.filter((n) => map[n] !== jsCat(n));
    assert(diff.length === 0, `parity mismatches: ${diff.join(",")}`);
  });

  await run("module: HUD/chip/ghost/diff/sound surface", async () => {
    for (const needle of [
      "function ToolVisualizer.init", "function ToolVisualizer.onClaim",
      "function ToolVisualizer.onDone", "function ToolVisualizer.setEnabled",
      "function ToolVisualizer.isEnabled", "function ToolVisualizer.setSound",
      "function ToolVisualizer.getStats", "function ToolVisualizer.categoryOf",
      "function ToolVisualizer.compactDiff",
      "RoLinkHUD", "BillboardGui", "SelectionBox", "Beam",
      "Debris", "PlayLocalSound", "rbxasset://sounds/",
      "SetWaypoint", // absent here — commands still waypoint in caller, not HUD
    ]) {
      if (needle === "SetWaypoint") {
        assert(!module.includes(needle), "visualizer never touches undo history");
      } else assert(module.includes(needle), `module contains ${needle}`);
    }
  });

  await run("module: never throws (pcall discipline)", async () => {
    assert(!/\berror\s*\(/.test(module), "no error() calls");
    for (const fn of ["onClaim", "onDone", "init"]) {
      const i = module.indexOf("function ToolVisualizer." + fn);
      assert(i >= 0, fn + " present");
      const body = module.slice(i, module.indexOf("\nend", i) + 4);
      assert(body.includes("pcall"), fn + " pcall-guarded");
    }
  });

  await run("RoLink.lua: HUD button + claim/done hooks + sync marker", async () => {
    for (const needle of [
      "VISUALIZER SYNC", 'toolbar:CreateButton("HUD"',
      "VisualizerOnClaim(cmd)", "VisualizerOnDone(cmd, result, err, elapsed)",
      'hudBtn.Click:Connect', "RoLinkChip_", "RoLinkPin_", "RoLinkDiff",
      "SelectionBox", "PlayLocalSound",
    ]) assert(rolua.includes(needle), `RoLink.lua contains ${needle}`);
  });

  await run("init.plugin.luau: optional module + hooks + toggle", async () => {
    for (const needle of [
      "toolVisualizer", "ToolVisualizer.init", "ToolVisualizer.onClaim",
      "ToolVisualizer.onDone", "ToolVisualizer.setEnabled", 'CreateButton("HUD"',
    ]) assert(rojo.includes(needle), `init.plugin.luau contains ${needle}`);
  });

  await run("queue: meta stamped, heal preserves, protocol typed", async () => {
    assert(queue.includes("categoryOfTool"), "commandQueue has categoryOfTool");
    assert(queue.includes("meta:"), "enqueue stamps meta");
    assert(queue.includes("payload.meta?.category ?? categoryOfTool"), "authoritative override kept");
    assert(index.includes("meta: cmd.meta"), "auto-heal re-enqueue preserves meta");
    assert(proto.includes("ToolEventMeta"), "protocol has ToolEventMeta");
    assert(proto.includes("meta?: ToolEventMeta"), "EnqueuePayload carries meta");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
