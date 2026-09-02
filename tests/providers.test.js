// SPDX-License-Identifier: GPL-3.0-or-later
// tests/providers.test.js - Smoke test that every provider loads in a
// sandbox, exposes a ZSProvider with the required interface, and that the
// provider-specific overrides don't crash the generic factory.
//
// Run: node tests/providers.test.js   (no deps)

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadInSandbox(scripts) {
  const ctx = { window: {}, globalThis: {}, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const s of scripts) vm.runInContext(s, ctx);
  return ctx.window;
}

let passed = 0, failed = 0;
function ok(m){ console.log("✓", m); passed++; }
function bad(m, e){ console.error("✗", m, e && e.message || ""); failed++; }
function assert(cond, msg){ if(!cond) throw new Error(msg); }

(async () => {
  const generic = fs.readFileSync(path.join(__dirname, "..", "rolink-extension", "providers", "generic.js"), "utf8");
  const providers = [
    "chatgpt","gemini","kimi","glm","qwen","arena","meta","deepseek"
  ];
  for (const p of providers) {
    try {
      const code = fs.readFileSync(path.join(__dirname, "..", "rolink-extension", "providers", p + ".js"), "utf8");
      const w = loadInSandbox([generic, code]);
      assert(w.ZSProvider, p + ": ZSProvider not exposed");
      const P = w.ZSProvider;
      assert(typeof P.id === "string" && P.id.length, p + ": missing id");
      assert(typeof P.displayName === "string" && P.displayName.length, p + ": missing displayName");
      // Required interface surface
      const required = ["allItems","assistantCount","getEditor","editorText","isGenerating","typeAndSend","stopGeneration","installSendHooks","findToolBlockSpot","attachImages"];
      for (const k of required) assert(typeof P[k] === "function", p + ": missing " + k);
      // timings is required
      assert(P.timings && typeof P.timings.GEN_IDLE_MS === "number", p + ": timings missing");
      // No crash on calling safe no-ops
      ok(p + " loads + passes interface");
    } catch (e) { bad(p, e); }
  }

  // The MAIN-world hooks (chatgpt-cm.js, qwen-net.js) should be harmless
  // when no chatgpt.com / chat.qwen.ai is loaded — they just need to
  // install without throwing.
  for (const f of ["chatgpt-cm.js", "qwen-net.js"]) {
    try {
      const code = fs.readFileSync(path.join(__dirname, "..", "rolink-extension", "providers", f), "utf8");
      const w = loadInSandbox([code]);
      assert(w, f + ": sandbox returned nothing");
      ok(f + " loads in sandbox");
    } catch (e) { bad(f, e); }
  }

  console.log(`\nProvider tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
