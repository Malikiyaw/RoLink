// SPDX-License-Identifier: GPL-3.0-or-later
// tests/arena-agent-read.test.js — arena.ai/agent read-escalation suite.
//
// Failure mode: the model emits a valid ###MCP_TOOL### block in the agent
// trace, but the provider read never captures it (unknown step node types,
// virtualized fences) → the turn holds forever, zero dispatches, zero chips.
//
// Pins:
//   1. Multi-node join: settled step nodes join in document order.
//   2. Busy steps skipped.
//   3. Turn-container escalation when steps lack the signature.
//   4. Bounded page-scan escalation when the container also lacks it.
//   5. No-DOM safety preserved (falls back to baseRead).
//
// Run: node tests/arena-agent-read.test.js   (no deps)

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT = path.join(__dirname, "..", "rolink-extension");
let passed = 0, failed = 0;
async function run(n, fn) { try { await fn(); console.log("✓", n); passed++; } catch (e) { console.error("✗", n, "ASSERT FAILED:", e && e.message || ""); failed++; } }
function assert(c, m) { if (!c) throw new Error(m); }

function el(text, extra) {
  return Object.assign({
    innerText: text, textContent: text,
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  }, extra || {});
}

function loadArena(docStub, nodeFilter) {
  const generic = fs.readFileSync(path.join(EXT, "providers", "generic.js"), "utf8");
  const code = fs.readFileSync(path.join(EXT, "providers", "arena.js"), "utf8");
  const ctx = { window: {}, console, document: docStub };
  if (nodeFilter) ctx.NodeFilter = nodeFilter;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(generic, ctx);
  vm.runInContext(code, ctx);
  return ctx.window.ZSProvider;
}

const BLOCK = '###MCP_TOOL###\n{"tool":"get_studio_state","args":{}}';

(async () => {
  const arenaSrc = fs.readFileSync(path.join(EXT, "providers", "arena.js"), "utf8");

  await run("source: escalation helpers present", async () => {
    for (const needle of [
      "fenceTexts", "hasSig", "Escalation 1", "Escalation 2",
      "els.length - 1", "checked < 300", "parts.join",
    ]) assert(arenaSrc.includes(needle), "arena.js contains " + needle);
    assert(!arenaSrc.includes("guard++ < 4000"), "top-down guard retired");
  });

  await run("joins settled steps in order, skips busy", async () => {
    const steps = [
      el("Thought for 1 minute and 8 seconds"),
      el(BLOCK),
      el("streaming…", { getAttribute: (k) => (k === "aria-busy" ? "true" : null) }),
    ];
    const doc = {
      querySelectorAll: (s) => (s.indexOf("plan-step") !== -1 ? steps : []),
      querySelector: (s) => (s.indexOf("agent") !== -1 || s.indexOf("data-mode") !== -1 ? {} : null),
    };
    const P = loadArena(doc);
    assert(P.isAgentMode() === true, "agent mode detected via DOM marker");
    const r = P.readAssistant();
    assert(r.present === true, "present");
    assert(r.reply.indexOf("Thought for 1 minute") !== -1, "thought kept");
    assert(r.reply.indexOf("###MCP_TOOL###") !== -1, "block kept");
    assert(r.reply.indexOf("Thought for 1 minute") < r.reply.indexOf("###MCP_TOOL###"), "document order");
    assert(r.reply.indexOf("streaming") === -1, "busy step skipped");
  });

  await run("container escalation when steps lack signature", async () => {
    const container = el("Agent trace\n" + BLOCK + "\nDone");
    const steps = [el("Agent trace")];
    steps[0].closest = () => container;
    const doc = {
      querySelectorAll: (s) => (s.indexOf("plan-step") !== -1 ? steps : []),
      querySelector: (s) => (s.indexOf("agent") !== -1 || s.indexOf("data-mode") !== -1 ? {} : null),
    };
    const P = loadArena(doc);
    const r = P.readAssistant();
    assert(r.present === true, "present");
    assert(r.reply.indexOf("###MCP_TOOL###") !== -1, "container block found");
    assert(r.item === container, "item is the container");
  });

  await run("page-scan escalation when container lacks it too", async () => {
    const codeEl = {
      tagName: "CODE", parentElement: null,
      innerText: "", textContent: BLOCK,
      querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    };
    const turnEl = {
      tagName: "DIV", parentElement: null,
      innerText: "", textContent: "",
      querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    };
    const scope = {
      tagName: "MAIN",
      querySelectorAll: (s) => (s.indexOf("blockquote") !== -1 ? [turnEl, codeEl] : []),
    };
    codeEl.parentElement = turnEl;
    turnEl.parentElement = scope;
    const steps = [el("progress working…")];
    const doc = {
      querySelectorAll: (s) => (s.indexOf("plan-step") !== -1 ? steps : []),
      querySelector: (s) => {
        if (s === "main") return scope;
        return (s.indexOf("agent") !== -1 || s.indexOf("data-mode") !== -1) ? {} : null;
      },
    };
    const P = loadArena(doc, { SHOW_TEXT: 4 });
    const r = P.readAssistant();
    assert(r.present === true, "present");
    assert(r.reply.indexOf("###MCP_TOOL###") !== -1, "scanned block found");
    assert(r.item === codeEl, "item is the end-most matching block");
  });

  await run("no-DOM safe: falls back without throwing", async () => {
    const P = loadArena(undefined);
    assert(P.isAgentMode() === false, "not agent without DOM");
    const r = P.readAssistant();
    assert(r.present === false, "absent read without DOM");
  });

  console.log(`\nArena-agent-read tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
