// SPDX-License-Identifier: GPL-3.0-or-later
// tests/refusal-net.test.js - Identity-refusal net (Arena Agent Mode).
//
// Failure mode: the model doesn't claim inability — it denies the CHANNEL
// ("I'm not RoLink", "my actual toolset is…", "would just be text"). The old
// looksLikeCantRun misses that whole class, and its nudge gate requires
// toolCount > 0, which can never hold at bootstrap. This pins:
//   1. The agent-mode system prompt claims no identity and forbids no native
//      tools (those two lines are what trigger refusal-as-injection).
//   2. The Direct prompt is byte-identical in shape (still RoLink Agent).
//   3. The identity-refusal classifier hits refusal phrasings (including the
//      real Arena screenshot) and misses normal prose + classic cantRun
//      (which belongs to the cantRun net, not this one).
//   4. main.js wires the net: classifier + separate budget + rebuttal +
//      bootstrap-allowed (no toolCount gate on this path).
//
// The classifier lives in main.js's IIFE (DOM/chrome surface — not loadable
// in node, same reason as agent_loop.test.js). The behavioral stub below
// mirrors it line-for-line; the source-contract block keeps the mirror honest.
//
// Run: node tests/refusal-net.test.js   (no deps)

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let passed = 0, failed = 0;
async function run(name, fn) {
  try { await fn(); console.log("✓", name); passed++; }
  catch (e) { console.error("✗", name, "ASSERT FAILED:", e && e.message || ""); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function loadConfig() {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "rolink-extension", "core", "config.js"), "utf8");
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx, src };
}

// Mirror of looksLikeIdentityRefusal in core/main.js — keep in sync.
function looksLikeIdentityRefusal(text) {
  if (!text || text.length > 4000) return false;
  return /i('m|\s+am)?\s+not\s+(a\s+)?rolink/i.test(text)
      || /my actual toolset/i.test(text)
      || /would just be text/i.test(text)
      || /not connected to this chat/i.test(text)
      || /meant for a different setup/i.test(text)
      || /that prompt looks like/i.test(text)
      || (/\bno\b.{0,60}\bin this environment\b/i.test(text) && /\b(mcp|studio)\b.{0,20}\btools?\b/i.test(text))
      || /i don'?t have .* (mcp|studio).* tools?/i.test(text);
}

const SCREENSHOT_REFUSAL = "I need to be straight with you here: I'm not RoLink Agent, "
  + "and I don't have Roblox Studio MCP tools in this environment. I'm an agent on "
  + "Arena.ai, and my actual toolset is things like a sandboxed bash workspace. "
  + "If I printed a ###MCP_TOOL### block, nothing would execute; it would just be "
  + "text. That prompt looks like it's meant for a different setup (a RoLink/MCP "
  + "bridge where Roblox Studio is connected as a server). If you have that MCP "
  + "integration, it's not connected to this chat.";

(async () => {
  const { ctx } = loadConfig();
  const buildSystemPrompt = ctx.buildSystemPrompt;
  assert(typeof buildSystemPrompt === "function", "config exposes buildSystemPrompt");

  // ── 1: Direct prompt unchanged ──────────────────────────────────────
  await run("direct prompt still claims RoLink Agent identity", async () => {
    const p = buildSystemPrompt(undefined);
    assert(p.includes("You are RoLink Agent"), "identity line present");
    assert(p.includes("113 total"), "tool count current");
    assert(p.includes("⟪RL-SYS⟫"), "sys marker present");
  });

  await run("direct prompt per-provider notes intact", async () => {
    assert(buildSystemPrompt("deepseek").includes("DeepSeek"), "deepseek note");
    assert(buildSystemPrompt("arena").includes("Agent Mode"), "arena note");
    assert(!buildSystemPrompt("nope").includes("Provider note"), "unknown provider clean");
  });

  // ── 2: agent-mode prompt ────────────────────────────────────────────
  await run("agent prompt claims NO identity", async () => {
    const p = buildSystemPrompt("arena", { agentMode: true });
    assert(!/you are rolink/i.test(p), "no identity claim");
    assert(!/do not use any built-in/i.test(p), "no native-tool ban");
  });

  await run("agent prompt explains mechanism + demands verify-first-call", async () => {
    const p = buildSystemPrompt("arena", { agentMode: true });
    for (const needle of [
      "watches THIS chat", "[Tool result", "get_studio_state",
      "FIRST reply must be exactly one tool call", "113 total",
      "⟪RL-SYS⟫",
    ]) assert(p.includes(needle), "agent prompt contains: " + needle);
    assert(p.toLowerCase().includes("never claim to be"), "no-rolink-identity rule present");
  });

  await run("agent prompt keeps tool list + format contract", async () => {
    const p = buildSystemPrompt("arena", { agentMode: true });
    assert(p.includes("###MCP_TOOL###"), "block format");
    assert(p.includes("batch_queue"), "tool list present");
    assert(p.includes("create_animation_track"), "new anim tools listed");
  });

  // ── 3: classifier ───────────────────────────────────────────────────
  await run("classifier hits refusal phrasings", async () => {
    const hits = [
      SCREENSHOT_REFUSAL,
      "I'm not RoLink Agent.",
      "I am not a RoLink agent, I run in Arena.",
      "my actual toolset is bash and web search",
      "it would just be text, nothing executes",
      "that integration is not connected to this chat",
      "looks like it's meant for a different setup",
      "there are no MCP tools in this environment",
      "I don't have any Studio tools here",
    ];
    for (const h of hits) assert(looksLikeIdentityRefusal(h), "hit: " + h.slice(0, 50));
  });

  await run("classifier misses normal prose + classic cantRun", async () => {
    const misses = [
      "Yo! How can I help?",
      "Studio is connected and ready in Edit mode. What would you like to build?",
      "I can't run commands on your files", // classic cantRun — other net's job
      "Let me inspect the zombie's parts and find the right one.",
      '{"tool":"get_studio_state","args":{}}',
      "",
      "x".repeat(4001),
    ];
    for (const m of misses) assert(!looksLikeIdentityRefusal(m), "miss: " + String(m).slice(0, 50));
  });

  // ── 4: wiring source-contract ───────────────────────────────────────
  await run("main.js wires the refusal net", async () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "rolink-extension", "core", "main.js"), "utf8");
    for (const needle of [
      "looksLikeIdentityRefusal",
      "refusalNudgesLeft",
      "refusalRebuttal",
      "bridgeFactsLine",
      "agentStarter",
      "__rolinkRefusalNet",
      "buildSystemPrompt(agent",
      "agentMode:true",
    ]) assert(src.includes(needle), "main.js contains: " + needle);
    // The rebuttal path must NOT be gated on toolCount (bootstrap case).
    const idx = src.indexOf("looksLikeIdentityRefusal(reply.text)");
    assert(idx > 0, "classifier consulted on text replies");
    assert(!/looksLikeIdentityRefusal\(reply\.text\)[^;]*toolCount/.test(src),
      "no toolCount gate on refusal path");
  });

  console.log(`\nRefusal-net tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
