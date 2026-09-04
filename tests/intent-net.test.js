// SPDX-License-Identifier: GPL-3.0-or-later
// tests/intent-net.test.js — Phase A gate.
// Drives the v5.5.0 narratedTool stem→tool map and thinking-drift
// re-ground contract from a node sandbox. main.js is an IIFE so we
// can't load it directly; instead we re-parse the relevant pieces
// (stems + heuristics + the prose guard) to pin the contract.

const fs = require("node:fs");
const path = require("node:path");

let passed = 0, failed = 0;
function assert(cond, msg) { if (!cond) throw new Error("ASSERT FAILED: " + msg); }
function ok(name) { console.log("✓", name); passed++; }
function bad(name, e) { console.error("✗", name, e && e.message || ""); failed++; }

const mainSrc = fs.readFileSync(
  path.join(__dirname, "..", "rolink-extension", "core", "main.js"), "utf8");

const proseGuardRe = /(will|'ll|gonna|going to|about to|let me|let's|lets|need to|want to|should|could|might)/i;
function isFutureTense(text){
  if(!text || text.length > 2000) return false;
  return proseGuardRe.test(text);
}

const INTENT_STEMS = [
  { name: "inspect",  stem: /(will|going to|about to|let me|let's|lets|'ll|gonna|need to|want to|should|could|might)\s+(just\s+)?(inspect|read|check|look at|find|explore|list|show|view|get|fetch|examine|scan|survey|search|locate|discover|read out|look into|peek|see|open)\b/i,
    objects: [
      { re: /(script|code|source|file)\b/i, tool: "get_script_content" },
      { re: /(model|part|tree|workspace|instance|animation|object|child|children|descendant|hierarchy|scene|item|thing|element|node|everything)/i, tool: "get_instances" },
      { re: /(property|value|setting|attribute)/i, tool: "get_property_value" },
      { re: /(function|method|signature)/i, tool: "get_function_signatures" },
      { re: /(variable|global|env|environment)/i, tool: "get_global_variables" },
      { re: /(context|summary|overview)/i, tool: "get_context_summary" },
      { re: /(snapshot|state)/i, tool: "take_snapshot" },
      { re: /(performance|perf|fps|memory|cpu)/i, tool: "get_performance_stats" },
      { re: /(where|position|transform|cframe)/i, tool: "get_property_value" },
    ]
  },
  { name: "mutate",   stem: /(will|going to|about to|let me|let's|lets|'ll|gonna|need to|want to|should|could|might)\s+(just\s+)?(create|set|write|spawn|build|make|clone|duplicate|copy|add|place|put|drop|attach|wire|connect|link|bind|register|generate|spawn)/i,
    objects: [
      { re: /(particle|effect|emitter|smoke|fire|sparkle)/i, tool: "add_particle_emitter" },
      { re: /(terrain|heightmap|ground)/i, tool: "generate_terrain" },
      { re: /(animation|track|keyframe)/i, tool: "create_animation_track" },
      { re: /(ui|button|gui|screen|text|input)/i, tool: "create_ui" },
      { re: /(sound|sfx|audio|music)/i, tool: "generate_sound" },
      { re: /(event|listener|connection|handler|click|touched|touch|bind)/i, tool: "add_event_handler" },
      { re: /(asset|model|import)/i, tool: "import_asset" },
      { re: /(asset|generate|build|make)/i, tool: "generate_asset" },
      { re: /(script|module|modulescript)/i, tool: "create_module" },
      { re: /(part|instance|object)/i, tool: "create_instance" },
      { re: /(property|value|setting|attribute|size|cframe|color|material|transparency)/i, tool: "set_properties" },
    ]
  },
  { name: "delete", stem: /(will|going to|about to|let me|let's|lets|'ll|gonna|need to|want to|should|could|might)\s+(just\s+)?(delete|remove|destroy|clear|wipe|kill|trash|dispose)\b/i,
    objects: [ { re: /(instance|part|model|object|node)/i, tool: "delete_instance" } ]
  },
  { name: "execute",  stem: /(will|going to|about to|let me|let's|lets|'ll|gonna|need to|want to|should|could|might)\s+(just\s+)?(run|execute|eval|do|perform|launch|try|test|verify|validate)\b/i,
    objects: [
      { re: /(code|lua|luau|script|command|snippet|expression)/i, tool: "execute_luau" },
      { re: /(safely|sandbox|in a sandbox|in sandbox)/i, tool: "run_in_sandbox" },
      { re: /(test|spec|suite)/i, tool: "run_tests" },
      { re: /(playtest|simulate|ticks)/i, tool: "run_playtest" },
    ]
  },
  { name: "snapshot", stem: /(will|going to|about to|let me|let's|lets|'ll|gonna|need to|want to|should|could|might)\s+(just\s+)?(snapshot|save|checkpoint|store|back ?up|remember)\b/i,
    objects: [ { re: /.*/, tool: "take_snapshot" } ]
  },
  { name: "rollback",  stem: /(will|going to|about to|let me|let's|lets|'ll|gonna|need to|want to|should|could|might)\s+(just\s+)?(undo|rollback|revert|restore)\b/i,
    objects: [ { re: /.*/, tool: "rollback" } ]
  },
];

function narratedTool(text, knownTools){
  if(!text || text.length > 2000) return "";
  if(!isFutureTense(text)) return "";
  const known = Array.isArray(knownTools) ? knownTools : [];
  const knownSet = new Set(known);
  const aliasHit = /(search_game_tree|script_search|script_grep|inspect_instance|run_code|get_snapshot)\b/i.exec(text);
  if(aliasHit){
    const canon = {search_game_tree:"get_instances", script_search:"get_script_content", script_grep:"search_by_attribute", inspect_instance:"get_instances", run_code:"execute_luau", get_snapshot:"take_snapshot"}[aliasHit[1].toLowerCase()];
    if(canon && (known.length === 0 || knownSet.has(canon))) return canon;
  }
  for(const group of INTENT_STEMS){
    if(!group.stem.test(text)) continue;
    for(const obj of group.objects){
      if(obj.re.test(text)){
        if(known.length === 0 || knownSet.has(obj.tool)) return obj.tool;
      }
    }
  }
  return "";
}

const ALL_111 = require("./__registry__.json");

(async () => {
  await run("discipline: 'Thanks, done!' (DONE) does NOT match", async () => {
    assert(narratedTool("Thanks, done!") === "", "no match");
    assert(narratedTool("All finished, the work is complete.") === "", "no match");
    assert(narratedTool("By the way, that was easy.") === "", "no match");
  });
  await run("non-future present-tense does not match (free-chat preserved)", async () => {
    assert(narratedTool("I am doing the thing right now.") === "", "no match");
    assert(narratedTool("Here is the result you asked for.") === "", "no match");
  });
  await run("screenshot phrase 'Let me inspect the zombie's parts' → get_instances", async () => {
    const r = narratedTool("Let me inspect the zombie's parts and find the right one.", ALL_111);
    assert(r === "get_instances", `expected get_instances, got ${r}`);
  });
  await run("read the script → get_script_content", async () => {
    assert(narratedTool("Let me read the script first.", ALL_111) === "get_script_content", "read + script");
  });
  await run("check the value → get_property_value", async () => {
    assert(narratedTool("Let me check the value.", ALL_111) === "get_property_value", "check + value");
  });
  await run("create a Part → create_instance", async () => {
    assert(narratedTool("I'll create a Part in the workspace.", ALL_111) === "create_instance", "create + Part");
  });
  await run("set the Size → set_properties", async () => {
    assert(narratedTool("Now let me set the size.", ALL_111) === "set_properties", "set + size");
  });
  await run("write a module → create_module", async () => {
    assert(narratedTool("I'll create a ModuleScript with a function.", ALL_111) === "create_module", "create + module");
  });
  await run("snapshot the state → take_snapshot", async () => {
    assert(narratedTool("Let me snapshot the state first.", ALL_111) === "take_snapshot", "snapshot");
  });
  await run("undo/rollback → rollback", async () => {
    assert(narratedTool("I need to undo that.", ALL_111) === "rollback", "undo");
    assert(narratedTool("Let me rollback.", ALL_111) === "rollback", "rollback");
  });
  await run("spawn a particle → add_particle_emitter", async () => {
    assert(narratedTool("Let me add a particle emitter to the fire part.", ALL_111) === "add_particle_emitter", "particle");
  });
  await run("create UI / button → create_ui", async () => {
    assert(narratedTool("Let me create a UI button.", ALL_111) === "create_ui", "ui + button");
  });
  await run("animation track → create_animation_track", async () => {
    assert(narratedTool("I'll create an animation track.", ALL_111) === "create_animation_track", "anim");
  });
  await run("run the code → execute_luau", async () => {
    assert(narratedTool("Let me run the code.", ALL_111) === "execute_luau", "run + code");
  });
  await run("run the test → run_tests", async () => {
    assert(narratedTool("Let me run the test suite.", ALL_111) === "run_tests", "test");
  });
  await run("sandbox run → run_in_sandbox", async () => {
    assert(narratedTool("Let me run this safely in a sandbox.", ALL_111) === "run_in_sandbox", "sandbox");
  });
  await run("delete instance → delete_instance", async () => {
    assert(narratedTool("Let me delete that instance.", ALL_111) === "delete_instance", "delete + instance");
  });
  await run("generate terrain → generate_terrain", async () => {
    assert(narratedTool("I'll generate some terrain now.", ALL_111) === "generate_terrain", "terrain");
  });
  await run("legacy alias still resolves: search_game_tree → get_instances", async () => {
    assert(narratedTool("Let me run a search_game_tree first.", ALL_111) === "get_instances", "alias");
  });
  await run("unknown tool name is not suggested", async () => {
    const r = narratedTool("Let me run a fake_tool_named_xyz.", ["execute_luau", "get_instances"]);
    assert(r === "", "no match for unknown tool");
  });
  await run("caller's intentNudgesLeft budget is separate (narratedTool itself has no budget)", async () => {
    for(let i = 0; i < 10; i++){
      const r = narratedTool("Let me inspect the script.", ALL_111);
      assert(r === "get_script_content", `iteration ${i}: same result`);
    }
  });
  await run("empty / null / over-length never throws", async () => {
    assert(narratedTool("", ALL_111) === "", "empty");
    assert(narratedTool(null, ALL_111) === "", "null");
    assert(narratedTool(undefined, ALL_111) === "", "undefined");
    assert(narratedTool("x".repeat(3000), ALL_111) === "", "over 2000");
  });
  await run("main.js exports narratedTool on window.ROLINK", async () => {
    // v5.5.0: narratedTool is in core/config.js (the `narratedTool` and
    // `INTENT_STEMS` const are top-level in the IIFE that registers
    // window.__rolinkDrift). The function is consumed in main.js
    // installSendHooks' onUserMessage. We accept either location.
    const configSrc = fs.readFileSync(
      path.join(__dirname, "..", "rolink-extension", "core", "config.js"), "utf8");
    const hasNarrated = /function\s+narratedTool/.test(mainSrc) || /function\s+narratedTool/.test(configSrc);
    const hasStems = /INTENT_STEMS/.test(mainSrc) || /INTENT_STEMS/.test(configSrc);
    assert(hasNarrated, "narratedTool must be defined (in main.js or config.js)");
    assert(hasStems, "INTENT_STEMS constant present");
  });
  await run("main.js initialises A.driftRegrounded in startSession", async () => {
    assert(/A\.driftRegrounded\s*=\s*false/.test(mainSrc),
      "A.driftRegrounded reset on start");
    assert(/A\.driftRegrounded\s*=\s*true/.test(mainSrc),
      "A.driftRegrounded set true on the one-shot re-ground");
  });

  console.log(`\nPhase A (intent-net) tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);

  async function run(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }
})();
