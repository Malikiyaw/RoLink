// SPDX-License-Identifier: GPL-3.0-or-later
// _smoke_main.js — SCRATCH harness (delete after use). Boots core/main.js with
// stubbed DOM/chrome globals to catch load-time exceptions the static suites
// can't (run: node tests/_smoke_main.js from repo root or via absolute path).
const fs = require("node:fs");
const path = require("node:path");

function makeEl() {
  const kids = [];
  const listeners = {};
  const el = {
    style: {},
    dataset: {},
    id: "",
    className: "",
    innerHTML: "",
    textContent: "",
    title: "",
    disabled: false,
    hidden: false,
    value: "",
    parentNode: null,
    nextSibling: null,
    isConnected: false,
    get children() { return kids; },
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); },
      contains(c) { return this._s.has(c); }
    },
    setAttribute() {}, appendChild(c) { c.parentNode = el; kids.push(c); return c; },
    insertBefore(c) { c.parentNode = el; kids.push(c); return c; },
    removeChild() {}, querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(t, fn) { listeners[t] = fn; },
    removeEventListener() {}, scrollTo() {},
    focus() {}, click() {},
    matches() { return false; },
    closest() { return null; }
  };
  return el;
}

const globals = {};
globals.document = {
  hidden: false, readyState: "complete",
  documentElement: makeEl(),
  body: makeEl(),
  head: makeEl(),
  createElement: () => makeEl(),
  createDocumentFragment: () => makeEl(),
  createTextNode: () => ({ textContent: "" }),
  getElementById: () => makeEl(),
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  execCommand() { return true; },
  createEvent: () => ({ initEvent() {} })
};
globals.window = globals;
globals.addEventListener = () => {};
globals.removeEventListener = () => {};
globals.location = { pathname: "/", hostname: "chat.deepseek.com", href: "https://chat.deepseek.com/" };
globals.navigator = { clipboard: { writeText() { return Promise.resolve(); } }, userAgent: "smoke" };
globals.chrome = {
  runtime: {
    id: "smoke",
    lastError: null,
    getManifest: () => ({ version: "5.6.0" }),
    sendMessage: (msg, cb) => { if (cb) setTimeout(() => cb({ ok: false, error: "stub" }), 0); },
    onMessage: { addListener() {} }
  },
  storage: { local: { get(k, cb) { cb && cb({}); }, set() {} }, onChanged: { addListener() {} } },
  tabs: { query(cb) { cb && cb([]); }, sendMessage() {} },
  alarms: { create() {}, onAlarm: { addListener() {} } }
};
// Deep-boot provider: without window.ZSProvider, main.js early-returns at the
// top (`no ZSProvider found`) and never exercises the UI shell below. Give it
// a DeepSeek-like stub so the whole init path (bar, panels, wireUi, placeBar)
// runs.
globals.ZSProvider = {
  id: "deepseek",
  displayName: "DeepSeek",
  provClass: "rl-prov-deepseek",
  conversationKey: () => "/",
  barMount: () => ({ parent: globals.document.body, before: null }),
  composerFrame: () => null,
  overlayBlocking: () => false,
  findToolBlockSpot: () => null,
  assistantCount: () => 0,
  sendText() {},
  stopGeneration() {},
  onNative: () => {}
};
globals.MutationObserver = class { constructor() {} observe() {} disconnect() {} takeRecords() { return []; } };
globals.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globals.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globals.getComputedStyle = () => ({ backgroundColor: "rgb(0,0,0)" });
globals.scrollTo = () => {};
// Never let intervals fire during the boot smoke (init registers many).
const _realSetInterval = global.setInterval;
globals.setInterval = () => 0;
globals.setTimeout = global.setTimeout;
globals.clearInterval = () => {};
globals.clearTimeout = global.clearTimeout;
globals.console = console;

for (const [k, v] of Object.entries(globals)) { global[k] = v; }

const file = path.join(__dirname, "..", "rolink-extension", "core", "main.js");
const src = fs.readFileSync(file, "utf8");
try {
  // eval in this realm; main.js is an IIFE that boots immediately.
  // eslint-disable-next-line no-eval
  (0, eval)(src);
  console.log("SMOKE OK: main.js booted without throwing");
  process.exit(0);
} catch (e) {
  console.error("SMOKE FAIL:", e && e.message);
  console.error(e && e.stack ? String(e.stack).split("\n").slice(0, 6).join("\n") : "");
  process.exit(1);
}
