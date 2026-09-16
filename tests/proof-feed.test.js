// SPDX-License-Identifier: GPL-3.0-or-later
// tests/proof-feed.test.js - Fast proof, trusted feed-back, clip recovery.
//
// Failure mode (Arena Agent Mode): the model complies, but nothing executes:
// the turn won't settle (slow/clipped stream), the result post can't be
// verified (generation-start is always-true on busy pages), and the 120s
// proof timeout outlives Arena's task patience.
//
// Pins:
//   1. get_studio_state / list_roblox_studios tool timeout clamped to 15s.
//   2. Feed-back verifies posting via userCount growth (not generation),
//      retries submit-grade, stashes undelivered results and re-attaches.
//   3. Clip watchdog: open block >45s -> clip_stuck -> compact re-emit ask.
//   4. Last-resort dispatch: signature visible >30s + complete payload +
//      not already run -> dispatch (double-fire guarded).
//   5. Full-text fallback for clipped fences (generic + arena step path).
//   6. Startup feed logs the extension version (stale-code reports).
//
// Run: node tests/proof-feed.test.js   (no deps)

const fs = require("node:fs");
const path = require("node:path");

const EXT = path.join(__dirname, "..", "rolink-extension");
let passed = 0, failed = 0;
async function run(name, fn) {
  try { await fn(); console.log("✓", name); passed++; }
  catch (e) { console.error("✗", name, "ASSERT FAILED:", e && e.message || ""); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  const main = fs.readFileSync(path.join(EXT, "core", "main.js"), "utf8");
  const generic = fs.readFileSync(path.join(EXT, "providers", "generic.js"), "utf8");
  const arena = fs.readFileSync(path.join(EXT, "providers", "arena.js"), "utf8");
  const parser = require(path.join(EXT, "core", "parser.js"));

  // ── 1: fast proof clamp ─────────────────────────────────────────
  await run("probe tools clamped to 15s timeout", async () => {
    assert(/if\s*\(\s*name\s*===\s*"get_studio_state"\s*\|\|\s*name\s*===\s*"list_roblox_studios"\s*\)\s*timeout\s*=\s*15000/.test(main),
      "clamp present");
    assert(main.includes('if(name === "execute_luau") timeout = 20000'), "luau clamp intact");
  });

  // ── 2: trusted feed-back ────────────────────────────────────────
  await run("feed verifies via userCount growth with retries", async () => {
    assert(/for\s*\(\s*let attempt\s*=\s*0;\s*attempt\s*<\s*3/.test(main), "3 attempts");
    assert(/P\.userCount[\s\S]{0,60}>\s*preUser/.test(main), "userCount growth check");
    assert(main.includes("FAILED to post"), "explicit failure feed");
  });

  await run("undelivered results stashed + re-attached", async () => {
    assert(main.includes("A.pendingResult"), "stash exists");
    assert(main.includes("Re-attaching previously undelivered tool result"), "re-attach path");
  });

  // ── 3: clip watchdog ────────────────────────────────────────────
  await run("open block >45s -> clip_stuck -> re-emit ask", async () => {
    assert(main.includes('kind:"clip_stuck"'), "clip_stuck kind");
    assert(/openSince[\s\S]{0,80}45000/.test(main), "45s threshold");
    assert(main.includes("Re-emit the COMPLETE call compactly"), "re-emit copy");
    const resets = (main.match(/A\.clipNudgesLeft = 1/g) || []).length;
    assert(resets >= 4, `budget reset everywhere (found ${resets})`);
  });

  // ── 4: last-resort dispatch ─────────────────────────────────────
  await run("30s visible signature + complete payload -> guarded dispatch", async () => {
    assert(/sigSince[\s\S]{0,60}30000/.test(main), "30s threshold");
    assert(main.includes("dispatching settled payload"), "last-resort feed line");
    assert(/historyHasSettled\(nm,\s*normCmdKey\(nm/.test(main), "double-fire guard consulted");
  });

  // ── 5: full-text fallback ───────────────────────────────────────
  await run("generic + arena fall back to full DOM text", async () => {
    assert(generic.includes("function fullText"), "generic fullText helper");
    assert(/fullText\(i\)[\s\S]{0,200}stableBlockKey\(ft\)/.test(generic), "generic gate");
    assert(/el\.textContent[\s\S]{0,200}stableBlockKey\(ft\)/.test(arena), "arena step gate");
  });

  await run("hollow placeholder block dispatches nothing (parse_error path)", async () => {
    assert(parser.stableBlockKey("###MCP_TOOL###\n{} text") === "{}", "balanced but tool-less");
    assert(parser.extractAll("###MCP_TOOL###\n{} text").length === 0, "no callable extracted");
  });

  // ── 6: version log ──────────────────────────────────────────────
  await run("startup feed logs extension version", async () => {
    assert(main.includes("ROLINK_VERSION"), "version referenced");
    assert(/Agent starting up\$\{rlVer\}/.test(main), "version in startup line");
  });

  // ── 7: arena tempo + tunable settle ───────────────────────────────
  await run("arena overrides settle tempo, generic keeps defaults", async () => {
    const arena = fs.readFileSync(path.join(EXT, "providers", "arena.js"), "utf8");
    assert(arena.includes("BLOCK_SETTLE_MS: 1500"), "arena block settle 1.5s");
    assert(arena.includes("BLOCK_GEN_GRACE_MS: 1000"), "arena gen grace 1s");
    assert(arena.includes("STABLE_MS: 5000"), "arena text-stable 5s");
    assert(/const blockSettleMs = \(T && T\.BLOCK_SETTLE_MS\) \|\| 4000/.test(main),
      "tunable settle with 4s default");
    assert(/blockKey \? \(\(T && T\.BLOCK_GEN_GRACE_MS\)/.test(main),
      "complete-block gen grace tunable");
    // Payload tracking precedes the stop grace (ordering = the fix).
    assert(main.indexOf("let blockKey") < main.indexOf("const stopGrace"),
      "blockKey computed before stopGrace");
  });

  await run("generic factory passes custom timings through", async () => {
    const vm = require("node:vm");
    const generic = fs.readFileSync(path.join(EXT, "providers", "generic.js"), "utf8");
    const ctx = { window: {}, console };
    vm.createContext(ctx);
    vm.runInContext(generic + "\nwindow.__t = window.makeGenericProvider({id:'t', displayName:'T', timings:{BLOCK_SETTLE_MS:1}});", ctx);
    assert(ctx.window.__t.timings.BLOCK_SETTLE_MS === 1, "custom key survives");
    assert(typeof ctx.window.__t.timings.GEN_IDLE_MS === "number", "defaults retained");
    assert(typeof ctx.window.__t.fullText === "function", "fullText exposed");
    assert(typeof ctx.window.__t.stripVolatile === "function", "stripVolatile exposed");
  });

  // ── 8: verified send + stage timing ───────────────────────────────
  await run("feed uses gated verifiedSend + timing lines", async () => {
    assert(main.includes("async function verifiedSend"), "verifiedSend exists");
    assert(/P\.editorText[\s\S]{0,120}P\.userCount/.test(main), "acceptance gate checks both");
    assert(main.includes("result posted in ${Date.now()-feedStart}ms"), "feed timing line");
    assert(main.includes("bridge round-trip ${Date.now()-callStart}ms"), "dispatch timing line");
    const resets = (main.match(/A\.clipNudgesLeft = 1/g) || []).length;
    assert(resets >= 4, `clip budget resets (found ${resets})`);
    assert(/clipNudgesLeft: 1/.test(main), "clip budget initialized");
  });

  // ── 9: critical nudges use acceptance-gated sends (LMArena phase) ──
  await run("critical nudges route via sendCritical", async () => {
    assert(main.includes("async function sendCritical"), "sendCritical helper exists");
    assert(main.includes('await sendCritical("Your tool block looks cut off'), "clip nudge gated");
    assert(main.includes("await sendCritical(await refusalRebuttal()"), "refusal rebuttal gated");
    assert(main.includes('await sendCritical("Your last reply was truncated'), "truncated nudge gated");
    // No critical path still uses fire-once sendParked for these kinds.
    assert(!main.includes('await sendParked("Your tool block looks cut off'), "clip not fire-once");
    assert(!main.includes("await sendParked(await refusalRebuttal()"), "refusal not fire-once");
    // Agent acceptance gate is faster to beat the task clock.
    assert(/gateMs = 2000/.test(main), "agent gate 2s");
  });

  await run("greeting collapse + keep-working copy", async () => {
    assert(main.includes("Reply with the greeting in this same turn"), "agent greeting tail");
    const cfg = fs.readFileSync(path.join(EXT, "core", "config.js"), "utf8");
    assert(cfg.includes("keep working — the user is still here"), "keep-working line");
  });

  console.log(`\nProof/feed tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
