// SPDX-License-Identifier: GPL-3.0-or-later
// tests/fragment-scan.test.js — span-split marker tolerance (5.17.2).
//
// Failure mode: arena.ai/agent renders replies tokenized across spans, so
// the DOM text reads "### MCP_TOOL ###" (or hash-split / ZWSP variants)
// while the user plainly sees the block. Every reader and sweep went blind
// and Timeline stayed at "no tools yet" with zero dispatches.
//
// Pins:
//   1. canonicalizeForScan rejoins markers; clean inputs byte-identical;
//      prose headers ("### Summary ###") stay inert.
//   2. hasToolSignature / stableBlockKey / extract / extractAll work on
//      fragmented text and round-trip identical calls.
//   3. Clean inputs never double-publish (single queued event).
//   4. Open fragmented blocks hold (hasOpenToolBlock true).
//   5. main.js text-driven sweep + arena end-first scan wiring present.
//
// Run: node tests/fragment-scan.test.js   (no deps)

const fs = require("node:fs");
const path = require("node:path");

const EXT = path.join(__dirname, "..", "rolink-extension");
const parser = require(path.join(EXT, "core", "parser.js"));

let passed = 0, failed = 0;
async function run(n, fn) { try { await fn(); console.log("✓", n); passed++; } catch (e) { console.error("✗", n, "ASSERT FAILED:", e && e.message || ""); failed++; } }
function assert(c, m) { if (!c) throw new Error(m); }

const CLEAN = '###MCP_TOOL###\n{"tool":"get_studio_state","args":{}}';
const SPACED = '### MCP_TOOL ###\n{"tool":"get_studio_state","args":{}}';
const HASH_SPLIT = '# # #MCP_TOOL# # #\n{"tool":"get_studio_state","args":{}}';
const ZWSP = '###MCP_TOOL###\n{"tool":"get_\u200bstudio_state","args":{}}';

(async () => {
  await run("canonicalize: clean inputs byte-identical", async () => {
    assert(parser.canonicalizeForScan(CLEAN) === CLEAN, "clean stable");
    assert(parser.canonicalizeForScan("") === "", "empty stable");
  });

  await run("canonicalize: rejoins split markers", async () => {
    assert(parser.canonicalizeForScan(SPACED) === CLEAN, "spaced rejoined: " + parser.canonicalizeForScan(SPACED));
    assert(parser.canonicalizeForScan(HASH_SPLIT) === CLEAN, "hash-split rejoined");
    const z = parser.canonicalizeForScan(ZWSP);
    assert(z.indexOf("get_studio_state") !== -1, "ZWSP removed, value intact");
  });

  await run("canonicalize: prose headers stay inert", async () => {
    const prose = "### Summary ###\nGreat work on the quest system";
    assert(parser.canonicalizeForScan(prose) === prose, "prose untouched");
    assert(!parser.hasToolSignature(prose), "no signature on prose");
    assert(parser.extractAll(prose).length === 0, "nothing extracted from prose");
  });

  await run("signature + key work on fragmented text", async () => {
    for (const t of [CLEAN, SPACED, HASH_SPLIT]) {
      assert(parser.hasToolSignature(t), "signature: " + t.slice(0, 20));
      assert(parser.stableBlockKey(t) === '{"tool":"get_studio_state","args":{}}', "key: " + t.slice(0, 20));
    }
    assert(parser.stableBlockKey("### MCP_TOOL ###\n{") === "", "incomplete stays open");
    assert(parser.hasOpenToolBlock("### MCP_TOOL ###\n{"), "open fragmented holds");
  });

  await run("extract round-trips identical calls (fragmented == clean)", async () => {
    const ref = parser.extract(CLEAN);
    assert(ref && ref.tool === "get_studio_state", "clean extracts");
    for (const t of [SPACED, HASH_SPLIT]) {
      const c = parser.extract(t);
      assert(c && c.tool === ref.tool, "tool equal: " + t.slice(0, 20));
      assert(JSON.stringify(c.args) === JSON.stringify(ref.args), "args equal");
    }
    const all = parser.extractAll("Done.\n" + SPACED + "\nThanks.");
    assert(all.length === 1 && all[0].tool === "get_studio_state", "extractAll finds one in prose");
  });

  await run("clean inputs never double-publish", async () => {
    const all = parser.extractAll(CLEAN);
    assert(all.length === 1, `exactly one call, got ${all.length}`);
  });

  await run("main.js text-driven sweep wiring present", async () => {
    const main = fs.readFileSync(path.join(EXT, "core", "main.js"), "utf8");
    for (const needle of [
      "scanAddedText", "rescanPending", "subtreeText", "_sweepPendingEl",
      "shadowRoot", "Saw a tool marker in chat but could not parse it",
    ]) assert(main.includes(needle), "main.js contains " + needle);
  });

  await run("arena end-first scan wiring present", async () => {
    const arena = fs.readFileSync(path.join(EXT, "providers", "arena.js"), "utf8");
    for (const needle of [
      "els.length - 1", "checked < 300", "fenceTexts",
    ]) assert(arena.includes(needle), "arena.js contains " + needle);
    assert(!arena.includes("guard++ < 4000"), "top-down guard retired");
  });

  console.log(`\nFragment-scan tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
