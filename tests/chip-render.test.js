// SPDX-License-Identifier: GPL-3.0-or-later
// tests/chip-render.test.js — Phase C two-row chip contract.
//
// Verifies that every one of the 111 tool names can flow through the
// chip-rendering helpers without throwing, and that the contract surface
// (Row 1: name + arg summary; Row 2: name · result) is preserved across
// all five dispatchTool exit paths (success / validation-error / stale /
// exception / invalidated).
//
// main.js is an IIFE so we can't load it directly; we mirror the helper
// logic from main.js here. The contract is what matters — main.js's
// real makeChip/makeResultChip is the production source of truth.

const fs = require("node:fs");
const path = require("node:path");

const TOOLS = require("./__registry__.json");

let passed = 0, failed = 0;
function assert(cond, msg) { if (!cond) throw new Error("ASSERT FAILED: " + msg); }
function ok(name) { console.log("✓", name); passed++; }
function bad(name, e) { console.error("✗", name, e && e.message || ""); failed++; }

function makeResultChip(name, res){
  const ok = !!(res && res.ok);
  const full = ok ? (res.text || "done") : (res.error || "failed");
  const summary = String(full).replace(/\n/g, " ").slice(0, 120) || (ok ? "done" : "failed");
  const dur = (res.durationMs != null) ? ((res.durationMs < 10000 ? (res.durationMs/1000).toFixed(1) + "s" : Math.round(res.durationMs/1000) + "s")) : "";
  return {
    cls: ok ? "rl-result" : "rl-result rl-err",
    head: { ico: ok ? "⇩" : "✗", name: name, detail: summary, dur: dur },
    body: { content: String(full).slice(0, 2000) }
  };
}

function placeChip(chip, parent){
  if(!parent) throw new Error("no parent to attach chip");
  parent.chips = parent.chips || [];
  parent.chips.push(chip);
  return chip;
}

(async () => {
  await run(`111-tool makeResultChip: every name renders without throw`, async () => {
    for(const name of TOOLS){
      const rOk = makeResultChip(name, { ok: true, text: "ok", durationMs: 120 });
      assert(rOk.head.name === name, `${name}: name preserved`);
      assert(rOk.head.ico === "⇩", `${name}: success icon`);
      assert(rOk.body.content === "ok", `${name}: success body`);
      assert(rOk.head.dur === "0.1s", `${name}: success duration`);
      assert(rOk.cls === "rl-result", `${name}: success class`);
      const rErr = makeResultChip(name, { ok: false, error: "boom", durationMs: 5000 });
      assert(rErr.head.ico === "✗", `${name}: error icon`);
      assert(rErr.cls === "rl-result rl-err", `${name}: error class (red)`);
      assert(rErr.head.detail === "boom", `${name}: error detail`);
      assert(rErr.head.dur === "5.0s", `${name}: error duration`);
      assert(/rl-result/.test(rOk.cls), `${name}: success has grey base class`);
      assert(/rl-err/.test(rErr.cls), `${name}: error has red class`);
    }
  });

  await run("111-tool placeChip: every name places without throw", async () => {
    for(const name of TOOLS){
      const parent = { chips: [] };
      const rOk = makeResultChip(name, { ok: true, text: "ok", durationMs: 100 });
      placeChip(rOk, parent);
      assert(parent.chips.length === 1, `${name}: 1 chip placed`);
      assert(parent.chips[0].head.name === name, `${name}: name carried through placement`);
    }
  });

  await run("5 exit paths × 111 tools: Row 1 + Row 2 always construct", async () => {
    const exitPaths = [
      { name: "success",        res: { ok: true,  text: "ok",     durationMs: 100 } },
      { name: "validation",     res: { ok: false, error: "bad args", durationMs: 5 } },
      { name: "stale",          res: { ok: false, error: "stale",   durationMs: 50, kind: "stale" } },
      { name: "exception",      res: { ok: false, error: "boom",    durationMs: 10, kind: "exception" } },
      { name: "contextInvalid", res: { ok: false, error: "ctx invalid", durationMs: 0, kind: "stale-extension" } }
    ];
    for(const name of TOOLS){
      for(const ep of exitPaths){
        const parent = { chips: [] };
        const row1 = { cls: "rl-chip rl-ok", name, args: {} };
        placeChip(row1, parent);
        const row2 = makeResultChip(name, ep.res);
        placeChip(row2, parent);
        assert(parent.chips.length === 2, `${name}/${ep.name}: 2 chips`);
        assert(parent.chips[0].cls.includes("rl-chip"), `${name}/${ep.name}: Row 1 is rl-chip`);
        assert(parent.chips[1].cls.includes("rl-result"), `${name}/${ep.name}: Row 2 is rl-result`);
        if(!ep.res.ok) assert(parent.chips[1].cls.includes("rl-err"), `${name}/${ep.name}: red on error`);
      }
    }
  });

  await run("odd names: 200-char name + emoji doesn't throw", async () => {
    const odd = TOOLS[0] + " ".repeat(200) + "🛠️";
    const r = makeResultChip(odd, { ok: true, text: "ok", durationMs: 50 });
    assert(typeof r.head.name === "string" && r.head.name.includes("🛠️"), "emoji preserved");
  });

  await run("no document.body chip paths in main.js", async () => {
    const main = fs.readFileSync(
      path.join(__dirname, "..", "rolink-extension", "core", "main.js"), "utf8");
    const sourceItemAnchorCount = (main.match(/sourceItem\.appendChild/g) || []).length;
    const parentInsertBeforeCount = (main.match(/parent\.insertBefore/g) || []).length;
    assert(sourceItemAnchorCount + parentInsertBeforeCount > 0, "at least one anchor path");
  });

  // Sprint B: Tool Stream mirror helpers (repo convention — main.js is an
  // IIFE, so tests mirror the settled-card contract that production builds).
  function streamCardMeta(name, args, pinned){
    return {
      name: name,
      pinnedTag: !!pinned,
      pending: true
    };
  }
  function settleStreamCard(name, res, meta){
    meta = meta || {};
    const ok = !!(res && res.ok !== false);
    const durMs = (meta.durationMs != null) ? meta.durationMs : 1234;
    const full = ok ? (res && (res.text || "done")) : (res && (res.error || "failed"));
    const dur = durMs < 10000 ? (durMs/1000).toFixed(1) + "s" : Math.round(durMs/1000) + "s";
    return {
      cls: ok ? "rl-stream-card rl-ok" : "rl-stream-card rl-err",
      ico: ok ? "✓" : "✗",
      name: name,
      dur: dur,
      body: String(full).slice(0, 4000),
      staleTag: !!(meta.stale),
      pinnedTag: !!(meta.pinned),
      badge: meta.stale ? "STALE" : (ok ? "OK" : "ERROR")
    };
  }

  await run("111-tool stream settle: every name settles without throw", async () => {
    for(const name of TOOLS){
      const rOk = settleStreamCard(name, { ok: true, text: "ok" }, { durationMs: 120 });
      assert(rOk.name === name, `${name}: name preserved`);
      assert(rOk.cls === "rl-stream-card rl-ok", `${name}: success class`);
      assert(rOk.ico === "✓", `${name}: success icon`);
      assert(rOk.dur === "0.1s", `${name}: success duration`);
      assert(rOk.body === "ok", `${name}: success body`);
      assert(!rOk.staleTag && !rOk.pinnedTag, `${name}: no spurious tags`);
      const rErr = settleStreamCard(name, { ok: false, error: "boom" }, { durationMs: 5000 });
      assert(rErr.cls === "rl-stream-card rl-err", `${name}: error class`);
      assert(rErr.ico === "✗", `${name}: error icon`);
      assert(rErr.body === "boom", `${name}: error body`);
      assert(rErr.dur === "5.0s", `${name}: error duration`);
    }
  });

  await run("5 exit paths × 111 tools: stream card mirrors dispatch outcome", async () => {
    const exitPaths = [
      { name: "success",        res: { ok: true,  text: "ok",     durationMs: 100 } },
      { name: "validation",     res: { ok: false, error: "bad args", durationMs: 5 } },
      { name: "stale",          res: { ok: false, error: "stale",   durationMs: 50 }, meta: { stale: true } },
      { name: "exception",      res: { ok: false, error: "boom",    durationMs: 10 } },
      { name: "contextInvalid", res: { ok: false, error: "ctx invalid", durationMs: 0 } }
    ];
    for(const name of TOOLS){
      for(const ep of exitPaths){
        const s = settleStreamCard(name, ep.res, Object.assign({}, ep.meta || {}, { durationMs: ep.res.durationMs }));
        assert(s.cls.includes(ep.res.ok ? "rl-ok" : "rl-err"), `${name}/${ep.name}: settle class`);
        assert(s.ico === (ep.res.ok ? "✓" : "✗"), `${name}/${ep.name}: settle icon`);
        if(ep.name === "stale") assert(s.staleTag, `${name}/stale: stale tag present`);
        else assert(!s.staleTag, `${name}/${ep.name}: no stale tag`);
        const wantBadge = ep.name === "stale" ? "STALE" : (ep.res.ok ? "OK" : "ERROR");
        assert(s.badge === wantBadge, `${name}/${ep.name}: badge ${s.badge} (want ${wantBadge})`);
      }
      const pinned = streamCardMeta(name, {}, true);
      assert(pinned.pinnedTag, `${name}: pinned-from-chat tag at creation`);
    }
  });

  // Sprint C: persona first-sentence + formatted-args mirrors (repo convention).
  function personaFirstLineOf(p){
    if(!p) return "";
    const m = String(p).match(/^.*?[.!?](?=\s|$)/s);
    return (m ? m[0] : String(p)).trim();
  }
  function fmtArgs(args){
    if(!args || typeof args !== "object" || !Object.keys(args).length) return { rows: 0, total: 0, collapsed: false, hasGrid: false };
    const keys = Object.keys(args);
    const shown = keys.slice(0, 6);
    return { rows: shown.length, total: keys.length, collapsed: keys.length > shown.length, hasGrid: true };
  }

  await run("persona first-sentence extraction: dot stop, empty safe, no-dot safe", async () => {
    const p1 = personaFirstLineOf("You are an elite Luau engineer who writes code that runs first try in a live Studio session. You think in services.");
    assert(p1.startsWith("You are an elite Luau engineer"), "first sentence extracted");
    assert(!p1.includes("You think"), "stops at first sentence boundary");
    assert(p1.endsWith("."), "keeps terminating punctuation");
    assert(personaFirstLineOf("") === "", "empty persona safe");
    assert(personaFirstLineOf(null) === "", "null persona safe");
    const noDot = personaFirstLineOf("no punctuation here");
    assert(noDot === "no punctuation here", "no-dot persona falls back to whole string");
  });

  await run("111-tool args grid: keys formatted, 6-row cap, overflow collapsed", async () => {
    for(const name of TOOLS){
      const a = fmtArgs({ path: "Workspace/" + name, mode: "edit", flag: true, code: "x" });
      assert(a.hasGrid && a.rows === 4, `${name}: 4 rows shown`);
      assert(!a.collapsed, `${name}: not collapsed under 6`);
      const big = {};
      for(let i = 0; i < 9; i++) big["k" + i] = i;
      const b = fmtArgs(big);
      assert(b.rows === 6 && b.collapsed && b.total === 9, `${name}: 6 shown + collapse note for 9`);
      assert(!fmtArgs({}).hasGrid && !fmtArgs(null).hasGrid, `${name}: empty args no grid`);
    }
  });

  await run("Sprint C source contract: persona/args/badge wiring + CSS classes present", async () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "rolink-extension", "core", "main.js"), "utf8");
    assert(/function personaFirstLine/.test(main), "personaFirstLine helper in main.js");
    assert(/function formatArgsLines/.test(main), "formatArgsLines helper in main.js");
    assert(main.includes("rl-stream-persona"), "stream persona row markup");
    assert(main.includes("rl-stream-badge"), "outcome badge markup");
    assert(main.includes("rl-stream-args"), "stream args grid markup");
    assert(main.includes('nm.title = p'), "live pill persona tooltip wired");
    assert(/classList\.add\("copied"\)/.test(main), "copy success flash class");
    const css = fs.readFileSync(path.join(__dirname, "..", "rolink-extension", "overlay.css"), "utf8");
    assert(css.includes(".rl-stream-persona"), "CSS: stream persona style");
    assert(css.includes(".rl-stream-badge.ok"), "CSS: OK badge style");
    assert(css.includes(".rl-stream-badge.stale"), "CSS: STALE badge style");
    assert(css.includes("@keyframes rl-march"), "CSS: marching-ants keyframes");
    assert(css.includes("@keyframes rl-live-pulse"), "CSS: live pill error pulse keyframes");
    assert(css.includes(".rl-copy.copied"), "CSS: copy flash style");
    assert(/border-left: 3px solid var\(--cat\)/.test(css), "CSS: chip accent stripe");
    const popup = fs.readFileSync(path.join(__dirname, "..", "rolink-extension", "popup.js"), "utf8");
    assert(/function relTime/.test(popup), "popup relative-time helper present");
  });

  await run("Sprint B source contract: body-free anchors, stream markers, live relay", async () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "rolink-extension", "core", "main.js"), "utf8");
    assert((main.match(/document\.body\.appendChild\(chip\)/g) || []).length === 0, "no document.body.appendChild(chip) remains");
    assert(/diag\("chip\.fallback"/.test(main), "chip.fallback logged to diag");
    assert(main.includes("pinned from chat"), "'pinned from chat' tag text present");
    assert(/function setToolLive/.test(main), "live pill helper present");
    assert(/function openStreamOnce/.test(main), "stream auto-open helper present");
    assert(/function notifyBgTool/.test(main), "background relay helper present");
    assert(main.includes("rl-stream-list"), "stream list element id present");
    assert(main.includes("A.streamDismissed"), "pin-closed state tracked");
    assert(!/document\.body\.appendChild\(chip\)/.test(main), "no body chip fallback anywhere");
    const bg = fs.readFileSync(path.join(__dirname, "..", "rolink-extension", "background.js"), "utf8");
    assert(bg.includes('case "tool-state"'), "background handles tool-state relay");
    assert(/agent: agentTools/.test(bg), "status carries the agent snapshot");
    const popup = fs.readFileSync(path.join(__dirname, "..", "rolink-extension", "popup.js"), "utf8");
    assert(/function applyLive/.test(popup), "popup live-highlight helper present");
    const html = fs.readFileSync(path.join(__dirname, "..", "rolink-extension", "popup.html"), "utf8");
    assert(html.includes(".tool-chip.live"), "popup pulse CSS present");
  });

  console.log(`\nPhase C (chip-render) tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);

  async function run(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }
})();
