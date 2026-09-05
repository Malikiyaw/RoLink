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

  // ── 5.7.0 — 1000x chip meta mirrors (repo convention: mirror the helpers) ──
  function esc(s){ return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function estTokens(str){ try{ return Math.ceil(String(str == null ? "" : str).length / 4); }catch{ return 0; } }
  function fmtTok(n){ n = Number(n) || 0; return n >= 10000 ? "≈" + (n / 1000).toFixed(1) + "k tok" : "~" + n + " tok"; }
  function prettyResult(text){
    let body = String(text == null ? "" : text);
    let pretty = false, html = "";
    try{
      const t = body.trim();
      if(t && (t[0] === "{" || t[0] === "[") && t.length <= 4000){
        body = JSON.stringify(JSON.parse(t), null, 2);
        pretty = true;
        html = body.split("\n").map((l, i) => `<span class="rl-ln">${i + 1}</span>${esc(l)}`).join("\n");
      }
    }catch{}
    if(body.length > 4000) body = body.slice(0, 3960) + "\n… (truncated — Copy for full)";
    return { text: body, html, pretty };
  }
  function renderArgsGrid(args){
    if(!args || typeof args !== "object" || !Object.keys(args).length) return { rows: 0, total: 0, collapsed: false, hasGrid: false, values: [] };
    const keys = Object.keys(args);
    const shown = keys.slice(0, 6);
    const values = [];
    for(const k of shown){
      let v = args[k];
      try{ v = (v && typeof v === "object") ? JSON.stringify(v) : String(v); }catch{ v = String(v); }
      const vFull = String(v);
      let vShort = vFull;
      if(vShort.length > 80) vShort = vShort.slice(0, 44) + " … " + vShort.slice(-34);
      values.push({ k, vFull, vShort });
    }
    return { rows: shown.length, total: keys.length, collapsed: keys.length > shown.length, hasGrid: true, values };
  }
  function settledTokMeta(callTok, fullText){
    const totTok = (Number(callTok) || 0) + estTokens(String(fullText));
    return totTok > 0 ? fmtTok(totTok) : "";
  }

  await run("5.7.0 estTokens contract: integer, deterministic, monotonic, empty=0", async () => {
    assert(estTokens("") === 0 && estTokens(null) === 0 && estTokens(undefined) === 0, "empty/null/undefined → 0");
    assert(Number.isInteger(estTokens("abcd")) && estTokens("abcd") === 1, "4 chars → 1 token");
    assert(estTokens("abc") === 1, "ceil rounding (3 chars → 1)");
    const long = "x".repeat(400);
    assert(estTokens(long) === 100, "400 chars → 100");
    assert(estTokens(long + "y") >= estTokens(long), "monotonic in length");
    assert(estTokens(long) === estTokens(long), "deterministic");
    for(const name of TOOLS) assert(Number.isInteger(estTokens(name)) && estTokens(name) > 0, `${name}: name token estimate positive int`);
  });

  await run("5.7.0 fmtTok: pill formatting, ≈k over 10k", async () => {
    assert(fmtTok(0) === "~0 tok", "zero → ~0 tok");
    assert(fmtTok(55) === "~55 tok", "small → ~N tok (screenshot parity)");
    assert(fmtTok(9999) === "~9999 tok", "just under 10k stays exact");
    assert(fmtTok(10000) === "≈10.0k tok", "10k → ≈k form");
    assert(fmtTok(12345) === "≈12.3k tok", "12345 → ≈12.3k tok");
    assert(fmtTok("not-a-number") === "~0 tok", "garbage safe");
  });

  await run("111-tool args grid from Zod samples: every tool renders, cap honored", async () => {
    const SAMPLES = require("./tool-samples.json");
    assert(Object.keys(SAMPLES).length >= TOOLS.length, "samples cover the registry");
    for(const name of TOOLS){
      const args = SAMPLES[name] != null ? SAMPLES[name] : {};
      const g = renderArgsGrid(args);
      assert(g.hasGrid === (Object.keys(args).length > 0), `${name}: grid iff args present`);
      if(g.hasGrid){
        assert(g.rows <= 6, `${name}: 6-row cap`);
        assert(g.collapsed === (g.total > 6), `${name}: collapse iff >6`);
        for(const row of g.values){
          assert(row.vShort.length <= 84, `${name}/${row.k}: value shortened (got ${row.vShort.length})`);
          if(row.vFull.length > 80){
            assert(row.vShort.includes(" … "), `${name}/${row.k}: mid-ellipsis for long values`);
            assert(row.vShort.startsWith(row.vFull.slice(0, 44)), `${name}/${row.k}: keeps head`);
          }
        }
      }
      const running = settledTokMeta(estTokens(JSON.stringify(args)) + estTokens(name), "");
      assert(running === "" || /^~|^≈/.test(running), `${name}: running tok pill well-formed`);
    }
  });

  await run("(111+ tools) × 5 exit paths: settled meta (tok · duration · badge) constructs", async () => {
    const SAMPLES = require("./tool-samples.json");
    const exitPaths = [
      { name: "success",        res: { ok: true,  text: '{"ok":1}', durationMs: 100 } },
      { name: "validation",     res: { ok: false, error: "bad args", durationMs: 5 } },
      { name: "stale",          res: { ok: false, error: "stale",   durationMs: 50 } },
      { name: "exception",      res: { ok: false, error: "boom",    durationMs: 10 } },
      { name: "contextInvalid", res: { ok: false, error: "ctx invalid", durationMs: 0 } }
    ];
    for(const name of TOOLS){
      const args = SAMPLES[name] != null ? SAMPLES[name] : {};
      const callTok = estTokens(JSON.stringify(args)) + estTokens(name);
      for(const ep of exitPaths){
        const full = ep.res.ok ? (ep.res.text || "done") : (ep.res.error || "failed");
        const meta = settledTokMeta(callTok, full);
        assert(/^~\d+ tok$|^≈[\d.]+k tok$/.test(meta), `${name}/${ep.name}: meta well-formed (${meta})`);
        const durMs = ep.res.durationMs;
        const dur = durMs < 10000 ? (durMs/1000).toFixed(1) + "s" : Math.round(durMs/1000) + "s";
        assert(/^[\d.]+s$/.test(dur), `${name}/${ep.name}: duration well-formed`);
        const pr = prettyResult(full);
        assert(typeof pr.pretty === "boolean" && typeof pr.text === "string", `${name}/${ep.name}: prettyResult constructs`);
      }
    }
  });

  await run("5.7.0 prettyResult: JSON pretty-print bounded, non-JSON untouched, html escaped", async () => {
    const j = prettyResult('{"b":1,"a":[1,2]}');
    assert(j.pretty === true, "JSON detected");
    assert(j.text === '{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ]\n}', "2-space reformat");
    assert(j.html.includes("rl-ln") && j.html.includes("1</span>"), "numbered gutter html");
    assert(j.html.includes("&lt;script&gt;") === false, "sanity");
    const xss = prettyResult('{"x":"<script>alert(1)</script>"}');
    assert(xss.html.includes("&lt;script&gt;"), "html-escaped in gutter mode");
    assert(!xss.html.includes("<script>"), "no raw script tag in html");
    const plain = prettyResult("done in 42ms");
    assert(plain.pretty === false && plain.text === "done in 42ms" && plain.html === "", "non-JSON untouched");
    const big = prettyResult(JSON.stringify({ pad: "y".repeat(5000) }));
    assert(big.text.length <= 4000 && big.text.includes("(truncated"), "bounded at 4000 with marker");
    const malformed = prettyResult('{"broken":');
    assert(malformed.pretty === false && malformed.text === '{"broken":', "malformed JSON falls back raw");
  });

  await run("Sprint D source contract: 5.7.0 helpers wired on BOTH surfaces + CSS", async () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "rolink-extension", "core", "main.js"), "utf8");
    for(const fn of ["estTokens", "fmtTok", "prettyResult", "renderArgsGrid", "bumpTokSession", "updateStreamTotals"]){
      assert(new RegExp("function " + fn).test(main), `main.js: ${fn} helper present`);
    }
    assert(main.includes('renderArgsGrid(args, "rl-args-grid")'), "chat chip body uses the shared args grid");
    assert(main.includes('formatArgsLines(args)'), "stream card keeps its args-grid alias");
    assert((main.match(/prettyResult\(full\)/g) || []).length >= 3, "prettyResult wired in chipFinalize + makeResultChip + settleStreamCard");
    assert((main.match(/dataset\.callTok/g) || []).length >= 3, "call-token provenance captured on chip + card and read at settle");
    assert(/bumpTokSession\(name/.test(main), "session totals bumped from chipFinalize (the every-tool funnel)");
    assert(main.includes("rl-stream-totals"), "stream header totals element present");
    assert(main.includes("dataset.full"), "Copy reads raw (un-numbered) text");
    assert(!/function escapeHtml\(s\)\{\s*\/\/ First sentence/.test(main), "no dangling helper fragment");
    const css = fs.readFileSync(path.join(__dirname, "..", "rolink-extension", "overlay.css"), "utf8");
    for(const cls of [".rl-tok", ".rl-args-grid", ".rl-args-grid .rl-ak", ".rl-args-grid .rl-more", ".rl-ln", ".rl-stream-totals", "@keyframes rl-settle-ok", "@keyframes rl-settle-err", "html.rl-light .rl-tok", "html.rl-light .rl-args-grid"]){
      assert(css.includes(cls), `CSS: ${cls} present`);
    }
  });

  console.log(`\nPhase C (chip-render) tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);

  async function run(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }
})();
