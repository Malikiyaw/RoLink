// SPDX-License-Identifier: GPL-3.0-or-later
// tests/p4-polish.test.js — P4 polish regression suite.
// Run with: node tests/p4-polish.test.js   (no deps)
//
// Covers: 111-icon audit, palette groups, category toggles (options +
// hidden-cat store), bridge dashboard (background ring + popup Events tab).

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "rolink-extension");
let passed = 0, failed = 0;
function assert(c, m) { if (!c) throw new Error("ASSERT FAILED: " + m); }
function ok(n) { console.log(`✓ ${n}`); passed++; }
function fail(n, e) { console.error(`✗ ${n}: ${e && e.message}`); failed++; }
async function run(n, fn) { try { await fn(); ok(n); } catch (e) { fail(n, e); } }

function loadRegistry(seed) {
  const store = Object.assign({}, seed);
  const listeners = [];
  const ctx = {
    window: {}, console, setTimeout, clearTimeout,
    chrome: {
      storage: {
        local: {
          get: (keys, cb) => {
            const o = {};
            (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) o[k] = store[k]; });
            cb(o);
          },
          set: (obj, cb) => { Object.assign(store, obj); if (cb) cb(); },
        },
        onChanged: { addListener: (fn) => listeners.push(fn) },
      },
      runtime: {},
    },
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  ctx.module = { exports: {} };
  vm.createContext(ctx);
  for (const f of ["core/code-fields.js", "core/config.js", "core/tool-events.js"]) {
    vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), ctx);
  }
  vm.runInContext(fs.readFileSync(path.join(EXT, "ui/toolHud/toolRegistry.js"), "utf8"), ctx);
  return { api: ctx.ROLINK_TOOL_REGISTRY, store, listeners };
}

(async () => {
  const regSrc = fs.readFileSync(path.join(EXT, "ui/toolHud/toolRegistry.js"), "utf8");
  const dockSrc = fs.readFileSync(path.join(EXT, "ui/toolHud/sideDock.js"), "utf8");
  const tlSrc = fs.readFileSync(path.join(EXT, "ui/toolHud/bottomTimeline.js"), "utf8");
  const css = fs.readFileSync(path.join(EXT, "overlay.css"), "utf8");
  const bgSrc = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  const popupHtml = fs.readFileSync(path.join(EXT, "popup.html"), "utf8");
  const popupJs = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");
  const optHtml = fs.readFileSync(path.join(EXT, "options.html"), "utf8");
  const optJs = fs.readFileSync(path.join(EXT, "options.js"), "utf8");
  const registryNames = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "__registry__.json"), "utf8"));

  await run("icon audit: all 111 resolve a non-empty glyph", async () => {
    const { api } = loadRegistry();
    assert(Object.keys(api.ICON_OVERRIDES).length >= 30, `>=30 overrides, got ${Object.keys(api.ICON_OVERRIDES).length}`);
    const bad = registryNames.filter((n) => !api.iconFor(n));
    assert(bad.length === 0, `iconless: ${bad.join(",")}`);
    for (const n of registryNames) {
      assert(api.entryFor(n).icon === api.iconFor(n), `${n} entry uses iconFor`);
    }
  });

  await run("icon audit: overrides differ from category default", async () => {
    const { api } = loadRegistry();
    let distinct = 0;
    for (const [name, glyph] of Object.entries(api.ICON_OVERRIDES)) {
      assert(registryNames.includes(name), `override target is a real tool: ${name}`);
      assert(typeof glyph === "string" && glyph.length > 0, `${name} glyph non-empty`);
      const catIcon = api.CATEGORY_STYLE[api.entryFor(name).category].icon;
      if (glyph !== catIcon) distinct++;
    }
    assert(distinct >= 20, `>=20 overrides actually distinctive, got ${distinct}`);
  });

  await run("hidden-cat store: set/isHidden/notify/read", async () => {
    const { api, store } = loadRegistry();
    assert(api.HIDDEN_CATS_KEY === "rl-hidden-cats", "storage key");
    assert(api.isHidden("test") === false, "default visible");
    let notified = null;
    api.onHiddenChange((h) => { notified = h; });
    api.setHidden(["test", "tool"]);
    assert(api.isHidden("test") === true, "hidden after set");
    assert(api.isHidden("read") === false, "others visible");
    assert(notified && notified.test === true, "subscribers notified");
    assert(JSON.stringify(store["rl-hidden-cats"].sort()) === '["test","tool"]', "persisted");
  });

  await run("hidden-cat store: seeds from storage + external change", async () => {
    const { api, listeners } = loadRegistry({ "rl-hidden-cats": ["generate"] });
    let loaded = null;
    api.readHiddenCats((h) => { loaded = h; });
    assert(loaded && loaded.generate === true, "seeded from storage");
    assert(api.isHidden("generate") === true, "isHidden reflects seed");
    assert(listeners.length === 1, "onChanged listener registered");
    listeners[0]({ "rl-hidden-cats": { newValue: ["asset"] } }, "local");
    assert(api.isHidden("asset") === true, "external change applied");
    assert(api.isHidden("generate") === false, "old value cleared");
  });

  await run("options page: 8 toggles match registry order+colors", async () => {
    const { api } = loadRegistry();
    assert(optHtml.includes('id="catToggles"'), "toggles container in html");
    assert(optJs.includes('HIDDEN_CATS_KEY = "rl-hidden-cats"') || optJs.includes('"rl-hidden-cats"'), "same storage key");
    for (const cat of api.CATEGORY_ORDER) {
      assert(optJs.includes(`"${cat}"`), `options lists ${cat}`);
    }
    for (const [cat, style] of Object.entries(api.CATEGORY_STYLE)) {
      assert(optJs.includes(style.color), `options has ${cat} color ${style.color}`);
    }
  });

  await run("dock/timeline respect hidden categories", async () => {
    for (const [file, src] of [["sideDock.js", dockSrc], ["bottomTimeline.js", tlSrc]]) {
      assert(src.includes("isHidden"), `${file} consults isHidden`);
      assert(src.includes("readHiddenCats") && src.includes("onHiddenChange"), `${file} loads + subscribes`);
    }
  });

  await run("palette: grouped headers + preview tags + styles", async () => {
    for (const needle of ["rl-dock-pal-cat-h", "rl-dock-pal-prev", "paletteOrder", "CATEGORY_ORDER"]) {
      assert(dockSrc.includes(needle), `sideDock.js contains ${needle}`);
    }
    for (const needle of [".rl-dock-pal-cat-h", ".rl-dock-pal-prev", "html.rl-light .rl-dock-pal-prev"]) {
      assert(css.includes(needle), `overlay.css contains ${needle}`);
    }
  });

  await run("background: dashboard event ring (cap 20, dedup, served)", async () => {
    for (const needle of [
      "recentEvents", "RECENT_EVENTS_MAX", "recentEvents.findIndex",
      "recent: recentEvents.slice(-RECENT_EVENTS_MAX)",
    ]) assert(bgSrc.includes(needle), `background.js contains ${needle}`);
    const m = bgSrc.match(/RECENT_EVENTS_MAX\s*=\s*(\d+)/);
    assert(m && Number(m[1]) === 20, "ring capped at 20");
  });

  await run("popup: Events tab renders the dashboard feed", async () => {
    assert(popupHtml.includes('data-tab="events"'), "Events tab present");
    assert(popupHtml.includes('id="panel-events"'), "events panel present");
    assert(popupHtml.includes('id="eventsList"') && popupHtml.includes('id="eventsSummary"'), "feed + summary present");
    for (const needle of ["renderEvents", "fmtDur", ".ev-row", ".ev-dot", "s?.recent"]) {
      const hay = needle.startsWith(".") ? popupHtml : popupJs;
      assert(hay.includes(needle), `popup contains ${needle}`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
