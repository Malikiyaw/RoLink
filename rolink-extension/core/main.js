// SPDX-License-Identifier: GPL-3.0-or-later
// core/main.js - RoLink agentic loop + UI (the brain).
//
// Architecture (ZeroScript-style ZSProvider):
//   - providers/*.js exports a global ZSProvider object with the site-specific
//     bits: selectors, generation detection, send mechanics, image attach.
//   - core/parser.js exposes ZSParse (pure string parser) for tool blocks.
//   - This file owns the agent loop, UI, session state. It NEVER touches the
//     host site's DOM directly - everything goes through ZSProvider.
//   - All tool calls route through background.js (which owns the single bridge
//     WebSocket). The AI tab never opens its own WS.
//
// Loop (mirror of ZeroScript's proven design):
//   1. startSession(): drive the composer into agent-ready state (e.g. Expert
//      on DeepSeek), inject a real system prompt + the user's starter, send.
//   2. agentLoop(): wait for the AI's reply, classify it (tool / text / empty /
//      truncated / too-long). On tool: dispatch via bg(), replace the raw block
//      with a chip, feed the result back. On text: stop (the AI answered).
//   3. Auto-resume watchdog: if a tool's result is dropped on the floor (AI
//      went silent), re-feed the same payload. Bounded retries, no infinite loop.
//   4. Tab-visibility gate: pause while the AI tab is hidden (background tabs
//      throttle rendering), resume when foregrounded.

(function(){
  "use strict";
  if(window.__rolink_injected) return; window.__rolink_injected=true;

  const P = (typeof window !== "undefined" && window.ZSProvider) || null;
  const T = P ? P.timings : null;
  if(!P){ console.warn("[RoLink] no ZSProvider found on this page"); return; }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const log = (...a) => console.log("[rolink]", ...a);

  // ── chrome.runtime bridge ──────────────────────────────────────────────────
  let bgAvailable = !!(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
  function bg(msg){
    return new Promise(resolve=>{
      if(!bgAvailable){ resolve({ok:false, error:"extension not available"}); return; }
      try{
        chrome.runtime.sendMessage(msg, resp=>{
          if(chrome.runtime.lastError) return resolve({ok:false, error:chrome.runtime.lastError.message});
          resolve(resp || {ok:false, error:"no response from background"});
        });
      }catch(e){
        if(/Extension context invalidated|message port closed/i.test(String(e))) bgAvailable=false;
        resolve({ok:false, error:String(e)});
      }
    });
  }
  function isContextInvalidated(m){ return /Extension context invalidated|message port closed|Receiving end does not exist/i.test(m||""); }

  // ── state ────────────────────────────────────────────────────────────────
  const A = {
    started: false,            // user clicked Start; an active session exists
    starting: false,           // bootstrap in progress (system prompt + send)
    startingKey: null,         // conversation the bootstrap belongs to
    running: false,            // agent loop is running
    stopping: false,           // user clicked Stop, winding down
    loopKey: null,             // conversation the loop is bound to
    lastGenAt: 0,              // timestamp of last observed generation
    injecting: false,          // currently feeding something back to the AI
    busy: false,               // a tool is currently executing
    toolRunning: "",
    toolStart: 0,
    feedStreak: 0,             // tool-results fed back without an answer
    maxFeedStreak: 12,         // give up after this many in a row
    observeTarget: null,
    feedPending: null,         // the result we just sent back (for auto-resume match)
    lastFeedId: null,
    lastFeedAt: 0,
    lastFeedText: "",
    lastTextAt: 0,
    parked: false,             // paused because the tab is hidden
    tools: [],
    status: "offline",
    lastAssistantIdAtBoot: null,
  };

  // ── DOM helpers ──────────────────────────────────────────────────────────
  function el(tag, cls, html){ const e=document.createElement(tag); if(cls) e.className=cls; if(html!=null) e.innerHTML=html; return e; }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);}

  // ── UI shell ─────────────────────────────────────────────────────────────
  const root = el("div", ""); root.id="rl-root";
  document.documentElement.appendChild(root);

  // Centered launcher
  const launcher = el("button", "rl-launcher");
  launcher.innerHTML = `<span class="rl-logo">R</span><span class="rl-label">Start RoLink agent</span>`;
  launcher.setAttribute("aria-label", "Start RoLink agent");
  root.appendChild(launcher);

  // Status bar (mounted inside the composer via provider.barMount)
  const bar = el("div", "rl-bar"); bar.id = "rl-bar"; bar.style.display = "none";
  bar.innerHTML = `
    <span class="rl-dot" id="rl-dot"></span>
    <span class="rl-state" id="rl-state">RoLink: <small>…</small></span>
    <span class="rl-spacer"></span>
    <span class="rl-counter" id="rl-counter">0 tools</span>
    <button class="rl-btn" id="rl-tools-btn" title="Show available tools">🛠 Tools</button>
    <button class="rl-btn" id="rl-feed-btn" title="Show activity">📜 Log</button>
    <button class="rl-btn warn" id="rl-stop-btn" style="display:none" title="Stop the agent">■ Stop</button>
  `;
  root.appendChild(bar);

  // Tools panel
  const toolsPanel = el("div", "rl-tools");
  toolsPanel.innerHTML = `
    <div class="rl-tools-head">Tools <span class="pill" id="rl-tools-count">-</span></div>
    <div class="rl-tools-list" id="rl-tools-list">Loading…</div>
  `;
  root.appendChild(toolsPanel);

  // Activity feed
  const feed = el("div", "rl-feed");
  feed.innerHTML = `
    <div class="rl-feed-head"><span class="rl-feed-title">Activity</span><button class="rl-feed-clear" id="rl-feed-clear" title="Clear log">⌫</button></div>
    <div class="rl-feed-list" id="rl-feed-list"></div>
  `;
  root.appendChild(feed);

  // Banner
  const banner = el("div", "rl-banner"); banner.style.display = "none";
  root.appendChild(banner);

  function showBanner(text, kind, ms){
    banner.textContent = text;
    banner.className = "rl-banner" + (kind ? " " + kind : "");
    banner.style.display = "block";
    clearTimeout(banner._t);
    if(ms) banner._t = setTimeout(()=>{ banner.style.display = "none"; }, ms);
  }
  function pushFeed(kind, icon, text){
    const ts = new Date().toTimeString().slice(0,8);
    const row = el("div", "rl-feed-item rl-feed-" + kind);
    row.innerHTML = `<span class="rl-feed-ts">${ts}</span><span class="rl-feed-ico">${icon}</span><span class="rl-feed-text">${escapeHtml(text)}</span>`;
    const list = document.getElementById("rl-feed-list");
    list.appendChild(row);
    while(list.children.length > 200) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
    if(feed) feed.classList.add("rl-show");
  }
  function setCounter(n){ const c = document.getElementById("rl-counter"); if(c) c.textContent = n + " tool" + (n === 1 ? "" : "s"); }
  function setStatus(s){
    const dot = document.getElementById("rl-dot"), state = document.getElementById("rl-state");
    if(!dot || !state) return;
    dot.classList.remove("on","warn","err");
    if(s === "ready"){ dot.classList.add("on"); state.innerHTML = `RoLink: <small>Bridge + Studio ready</small>`; }
    else if(s === "studioOff"){ dot.classList.add("warn"); state.innerHTML = `RoLink: <small>Enable MCP in Roblox Studio</small>`; }
    else if(s === "bridge"){ dot.classList.add("warn"); state.innerHTML = `RoLink: <small>Bridge OK, open Studio</small>`; }
    else { state.innerHTML = `RoLink: <small>offline — run start.bat</small>`; }
  }
  async function refreshTools(){
    const r = await bg({type:"list_tools"});
    const arr = (r && Array.isArray(r.tools)) ? r.tools : [];
    A.tools = arr;
    const list = document.getElementById("rl-tools-list"), count = document.getElementById("rl-tools-count");
    if(!list) return;
    if(!arr.length){ list.textContent = r && r.error ? ("bridge: " + r.error) : "no tools — open Roblox Studio and enable MCP"; }
    else { list.innerHTML = arr.map(t => { const nm = (typeof t === "string") ? t : (t.name || JSON.stringify(t)); return `<span class="t" title="${escapeHtml((typeof t==="object"&&t&&t.description)||"")}">${escapeHtml(nm)}</span>`; }).join(""); }
    if(count) count.textContent = arr.length + " available";
  }
  document.getElementById("rl-tools-btn").onclick = e => { e.stopPropagation(); toolsPanel.classList.toggle("rl-show"); };
  document.getElementById("rl-feed-btn").onclick = e => { e.stopPropagation(); feed.classList.toggle("rl-show"); };
  document.getElementById("rl-feed-clear").onclick = e => { e.stopPropagation(); document.getElementById("rl-feed-list").innerHTML=""; };

  // Mount the bar inside the composer frame
  function placeBar(){
    try{
      const m = P.barMount();
      if(!m) return;
      if(bar.parentElement !== m.parent){ if(bar.parentElement) bar.parentElement.removeChild(bar); m.parent.insertBefore(bar, m.before || null); }
      bar.style.display = "flex";
    }catch{}
  }
  window.addEventListener("resize", placeBar);
  setInterval(placeBar, 1500);
  setTimeout(placeBar, 600);

  // ── tool chip helpers ────────────────────────────────────────────────────
  function makeChip(name, args){
    const chip = el("div", "rl-chip");
    const argsStr = args && Object.keys(args).length ? " " + JSON.stringify(args).slice(0,160) : "";
    chip.innerHTML = `<span class="rl-spinner"></span><span class="rl-ico">⚙</span><span><span class="rl-name">${escapeHtml(name)}</span><span style="opacity:.65">${escapeHtml(argsStr)}</span></span>`;
    return chip;
  }
  function chipFinalize(chip, name, res){
    chip.classList.remove("rl-err"); chip.classList.add(res.ok ? "rl-ok" : "rl-err");
    const ico = res.ok ? "✓" : "✗";
    let body = res.ok ? (res.text || "done") : (res.error || "failed");
    if(typeof body === "string" && body.length > 500) body = body.slice(0, 460) + "…";
    chip.innerHTML = `<span class="rl-ico">${ico}</span><span><span class="rl-name">${escapeHtml(name)}</span> <span style="opacity:.85;white-space:pre-wrap">${escapeHtml(String(body))}</span></span>`;
  }

  // ── THE SYSTEM PROMPT ─────────────────────────────────────────────────────
  // Strong, explicit. Works because the AI sees it as a user message with
  // "do this" framing (ZeroScript's proven approach).
  const SYSTEM_PROMPT = `You are RoLink Agent v1.0 — you control Roblox Studio on the user's local PC via MCP tools.

EVERY reply you write MUST follow one of these two patterns:

1) Call a tool: output a JSON code block that starts with ###MCP_TOOL### on its own line, then the JSON on the next line:
###MCP_TOOL###
{"tool":"run_code","args":{"code":"print('hello')"}}

2) You're completely done: give a short final answer and end with the word DONE on its own line.

Available tools (use ###MCP_TOOL### {json} for any of these — one block per call, you can call multiple per reply):
- run_code / execute_luau { code: "..." }  — run Luau in a sandbox, self-heals on syntax errors
- create_instance { className, parent, name, properties }
- delete_instance { path }
- set_property { path, property, value }
- get_property { path, property }
- get_snapshot / get_instance_tree { maxDepth, filter }
- get_studio_state {}  — is a place open?
- list_roblox_studios {}  — which Studios are connected
- search_assets { keyword, limit, category }  — Creator Store
- import_asset { assetId, parent }
- generate_asset { prompt, kind }
- start_stop_play { action: "play"|"stop" }
- screen_capture {}  — only if you're on a Vision-capable model
- open_external { url }
- …and more (the exact list is in the "🛠 Tools" panel of the extension)

Rules:
- NEVER claim you "cannot run commands" — your tools ARE working. Just emit the right ###MCP_TOOL### block.
- NEVER ask the user a clarifying question before acting. Make reasonable assumptions and ACT.
- If a tool call fails, read the error message and fix the call. Don't apologize and stop.
- Keep prose short. The user wants to see tool calls and results, not essays.
- When the user's task is fully done, give a one-sentence summary and end with DONE.`;

  const STARTER = `Start by taking a snapshot of the game tree so we can see what's there. Then ask the user what they want to build.`;

  // ── dispatch a tool call ──────────────────────────────────────────────────
  function dispatchTool(name, args, sourceBlock, sourceItem){
    if(sourceBlock && sourceBlock.parentElement){ sourceBlock.parentElement.style.display = "none"; }
    const chip = makeChip(name, args);
    if(sourceBlock && sourceBlock.parentElement && sourceBlock.parentElement.parentElement){
      sourceBlock.parentElement.parentElement.insertBefore(chip, sourceBlock.parentElement);
    } else {
      (sourceBlock || document.body).appendChild(chip);
    }
    A.busy = true; A.toolRunning = name; A.toolStart = Date.now();
    pushFeed("tool", "⚙", `${name} ${JSON.stringify(args).slice(0,180)}`);
    setCounter(++A.toolCount);
    bg({type:"call_tool", name, arguments: args, timeout: 120000}).then(res=>{
      A.busy = false; A.toolRunning = "";
      if(!res) res = {ok:false, error:"no response from bridge"};
      if(res.kind === "stale-extension" || isContextInvalidated(res.error)){
        chipFinalize(chip, name, {ok:false, error:"Extension updated — please reload this page and click Start again."});
        pushFeed("err", "✗", "Extension context invalidated. Reload the page.");
        A.running = false; setLauncherStopped(); return;
      }
      chipFinalize(chip, name, res);
      const text = res.ok ? (res.text || "OK") : ("ERROR: " + (res.error || "unknown"));
      const ok = res.ok !== false;
      pushFeed(ok ? "ok" : "err", ok ? "✓" : "✗", `${name}: ${String(text).slice(0,200).replace(/\n/g," ")}`);
      A.lastFeedText = text; A.lastFeedAt = Date.now(); A.lastFeedId = name + ":" + Date.now();
      const feedbackMsg = ok
        ? `[Tool result for ${name}]\n${text}\n\nYou MUST continue. Either call another tool via ###MCP_TOOL### {json} OR give a final answer ending with DONE. Do NOT respond with "I cannot run commands" — your tools are working.`
        : `[Tool error for ${name}]\n${text}\n\nThe tool call failed. Fix the call (correct args, valid JSON, valid Luau) and retry with another ###MCP_TOOL### block. If you can't fix it, explain the error to the user.`;
      A.injecting = true;
      P.typeAndSend(feedbackMsg, []).then(()=>{ A.injecting = false; });
    });
  }

  // ── send the user's starter request (after system prompt) ────────────────
  function sendSystemPromptAndStarter(){
    const first = SYSTEM_PROMPT + "\n\n---\n\n" + STARTER;
    return P.typeAndSend(first, []).then(()=>{
      A.starting = false;
      A.loopKey = P.conversationKey ? P.conversationKey() : location.pathname;
      A.running = true;
      A.feedStreak = 0;
      A.lastAssistantIdAtBoot = P.lastAssistantId ? P.lastAssistantId() : null;
      pushFeed("info", "▶", "Agent loop started. Watching AI replies…");
      agentLoop();
    }).catch(e=>{
      A.starting = false; A.started = false;
      pushFeed("err", "✗", "Could not send system prompt: " + e.message);
      setLauncherStopped();
    });
  }

  // ── visibility gate (pause while the AI tab is hidden) ──────────────────
  function waitForVisible(){
    if(!document.hidden || A.stopping) return Promise.resolve(!A.stopping);
    A.parked = true; pushFeed("info", "⏸", "Tab hidden — paused");
    return new Promise(resolve=>{
      const done = () => { document.removeEventListener("visibilitychange", onVis); clearInterval(iv); A.parked = false; resolve(!A.stopping); };
      const onVis = () => { if(!document.hidden) done(); };
      document.addEventListener("visibilitychange", onVis);
      const iv = setInterval(()=>{ if(A.stopping || !document.hidden) done(); }, 1000);
    });
  }

  // ── the main agent loop ───────────────────────────────────────────────────
  function agentLoop(){
    if(A.stopping){ A.running = false; setLauncherStopped(); return; }
    (async function tick(){
      while(A.running && !A.stopping){
        if(document.hidden){
          await waitForVisible();
          if(A.stopping) break;
        }
        const reply = await waitForReply();
        if(A.stopping) break;
        if(reply.kind === "tool"){
          A.feedStreak = 0;
          for(let i = 0; i < reply.calls.length; i++){
            const c = reply.calls[i];
            setTimeout(()=>dispatchTool(c.name, c.arguments, null, reply.item), i*30);
          }
        } else if(reply.kind === "text"){
          pushFeed("done", "🏁", `Agent finished (${A.toolCount} tool call${A.toolCount === 1 ? "" : "s"}).`);
          A.running = false; A.started = false;
          setLauncherStopped();
          showBanner("Agent finished. Click Start to run again.", "ok", 5000);
          return;
        } else if(reply.kind === "truncated"){
          // Click DeepSeek's "Continue" button (provider gives one if present)
          if(P.clickContinueBtn && P.clickContinueBtn()){ pushFeed("info", "↻", "Clicked Continue (truncated reply)"); continue; }
          // Otherwise nudge the AI to redo it
          A.injecting = true;
          await P.typeAndSend("Your last reply was truncated. Please redo the tool call (or final answer) in full. Do not include ###END markers or closing fences you don't need.", []);
          A.injecting = false;
        } else if(reply.kind === "empty"){
          A.feedStreak++;
          if(A.feedStreak > A.maxFeedStreak){
            pushFeed("err", "⏹", `Gave up after ${A.maxFeedStreak} empty replies. Click Start to try again.`);
            A.running = false; A.started = false; setLauncherStopped(); return;
          }
          // Auto-resume: re-feed the last result (if any), otherwise nudge.
          if(A.lastFeedText && (Date.now() - A.lastFeedAt) < 60000){
            pushFeed("info", "↻", `Empty reply — re-feeding last result (${A.feedStreak}/${A.maxFeedStreak})`);
            A.injecting = true;
            await P.typeAndSend(`[No reply received. Reminder: the last tool result was]\n${A.lastFeedText}\n\nPlease continue. Either call another tool via ###MCP_TOOL### or give a final answer ending with DONE.`, []);
            A.injecting = false;
          } else {
            A.injecting = true;
            await P.typeAndSend("Please continue. Use ###MCP_TOOL### {json} to call a tool, or end with DONE when finished.", []);
            A.injecting = false;
          }
        } else if(reply.kind === "parse_error"){
          pushFeed("err", "✗", "Malformed tool call — sending fix-it nudge");
          A.injecting = true;
          await P.typeAndSend(`Your last tool call was malformed (${reply.reason}). Please fix the JSON (use double quotes, no trailing commas, close all braces) and retry with another ###MCP_TOOL### block. If you want to answer the user in plain text instead, just do so without the JSON.`, []);
          A.injecting = false;
        } else if(reply.kind === "context_limit"){
          pushFeed("err", "⏹", "Context limit reached: " + (reply.detail||"").slice(0,200));
          A.running = false; A.started = false; setLauncherStopped();
          showBanner("Context limit reached. Open a new chat and click Start again.", "err", 8000);
          return;
        } else if(reply.kind === "too_long"){
          A.injecting = true;
          await P.typeAndSend("Your reply exceeded the model's context window. Please start a new chat (click the '+' / new chat button) and re-send your last request. I'll resume from there.", []);
          A.injecting = false;
        } else if(reply.kind === "stopped" || reply.kind === "timeout"){
          A.running = false; A.started = false; setLauncherStopped();
          pushFeed("info", "⏸", "Agent stopped: " + reply.kind);
          return;
        }
      }
    })().catch(e=>{
      console.error("[rolink] loop error", e);
      pushFeed("err", "✗", "Loop crashed: " + (e && e.message || e));
      A.running = false; A.started = false; setLauncherStopped();
    });
  }

  // ── wait for the AI to finish a reply, then classify ──────────────────────
  async function waitForReply(){
    const TIMEOUT = (T && T.RESPONSE_TIMEOUT_MS) || 300000;
    const t0 = Date.now();
    const STABLE_MS = (T && T.STABLE_MS) || 9000;
    const WARMUP_MS = (T && T.WARMUP_MS) || 30000;
    let lastActive = Date.now();
    let started = false;
    let lastText = null, lastChange = Date.now();
    let warmSince = 0;
    const lastSeenAssistantId = P.lastAssistantId ? P.lastAssistantId() : null;
    while(Date.now() - lastActive < TIMEOUT){
      if(A.stopping) return {kind:"stopped"};
      if(document.hidden){
        await waitForVisible();
        if(A.stopping) return {kind:"stopped"};
        lastActive += 500; // slide the deadline forward
      }
      const gen = P.isGenerating();
      if(gen) lastActive = Date.now();
      // Has a new reply turn appeared?
      const newId = P.lastAssistantId ? P.lastAssistantId() : null;
      const newTurn = lastSeenAssistantId == null
        ? (P.assistantCount() > 0)
        : (newId != null && newId !== lastSeenAssistantId);
      // Reply text (from the LAST assistant turn, which may be the same one
      // that's still being written)
      const d = P.readAssistant();
      const replyText = (d && d.reply) || "";
      const replyNorm = replyText.replace(/\s+/g," ").trim();
      if(replyNorm !== lastText){ lastText = replyNorm; lastChange = Date.now(); lastActive = Date.now(); }
      if(!started){
        // Need actual content (or a new turn) to consider the reply started
        if(newTurn && (replyText.length || gen)) started = true;
        else {
          if(!warmSince) warmSince = Date.now();
          if(Date.now() - warmSince > 60000) return {kind:"empty"};
          await sleep(200); continue;
        }
      }
      // Has the model finished (no more generating, text stable for STABLE_MS)?
      if(!gen){
        // We have a turn that has content. Wait STABLE_MS for it to settle.
        if(Date.now() - lastChange > STABLE_MS){
          // Classify
          const tools = ZSParse.extractAll(replyText);
          if(tools && tools.length){
            const calls = tools.map(ZSParse.normalize).filter(Boolean);
            if(calls.length){
              const lastId = newId;
              return {kind:"tool", calls, item: d.item, lastId};
            }
          }
          // Truncation button?
          if(P.findContinueBtn && P.findContinueBtn()) return {kind:"truncated", text: replyText, item: d.item};
          // Too long?
          if(P.isTooLongMsg && P.isTooLongMsg(replyText)) return {kind:"too_long", text: replyText};
          // Context limit toast?
          const ctx = P.scanError && P.scanError();
          if(ctx) return {kind:"context_limit", detail: ctx};
          // Parse error: marker but no valid JSON
          if(ZSParse.hasToolSignature(replyText)){
            return {kind:"parse_error", reason:"malformed", raw: replyText, item: d.item};
          }
          // Plain text → AI is done.
          if(!replyText.trim()) return {kind:"empty"};
          return {kind:"text", text: replyText, item: d.item};
        }
      } else {
        // Still generating → reset stable timer.
        lastChange = Date.now();
        await sleep(160); continue;
      }
      await sleep(200);
    }
    return {kind:"timeout"};
  }

  // ── launcher click: start a session ──────────────────────────────────────
  async function startSession(){
    if(A.started) return;
    A.started = true; A.starting = true; A.running = false; A.stopping = false;
    A.feedStreak = 0; A.toolCount = 0; A.lastFeedText = ""; A.lastFeedAt = 0; A.lastFeedId = null;
    setCounter(0);
    document.getElementById("rl-feed-list").innerHTML = "";
    launcher.classList.add("is-active");
    launcher.innerHTML = `<span class="rl-stop-dot"></span><span class="rl-label">Stop agent</span>`;
    document.getElementById("rl-stop-btn").style.display = "inline-flex";
    pushFeed("info", "▶", `Agent starting on ${location.hostname}`);
    showBanner("Agent starting…", "ok", 3000);
    placeBar();
    // Drive the composer into the required state (Expert on DeepSeek, etc.)
    if(P.ensureComposerReady){
      try{
        const s = await P.ensureComposerReady("startup");
        if(!s.ready){
          pushFeed("err", "⏹", "Composer not ready (no model selected). Pick Expert/Instant/Vision and try again.");
          A.started = false; A.starting = false; setLauncherStopped(); return;
        }
      }catch{}
    }
    A.startingKey = P.conversationKey ? P.conversationKey() : location.pathname;
    A.lastAssistantIdAtBoot = P.lastAssistantId ? P.lastAssistantId() : null;
    // Lock composer during inject so user can't accidentally abort
    try{ P.setInputLock && P.setInputLock(true); }catch{}
    sendSystemPromptAndStarter();
    try{ P.setInputLock && P.setInputLock(false); }catch{}
  }

  function stopSession(){
    if(!A.started) return;
    A.stopping = true; A.running = false; A.busy = false; A.injecting = false;
    if(P.stopGeneration) try{ P.stopGeneration(); }catch{}
    setLauncherStopped();
    pushFeed("info", "⏹", "Agent stopped by user");
    showBanner("Agent stopped. Click Start to run again.", "warn", 4000);
  }
  function setLauncherStopped(){
    launcher.classList.remove("is-active");
    launcher.innerHTML = `<span class="rl-logo">R</span><span class="rl-label">Start RoLink agent</span>`;
    document.getElementById("rl-stop-btn").style.display = "none";
  }

  launcher.addEventListener("click", ()=>{ if(A.started) stopSession(); else startSession(); });
  document.getElementById("rl-stop-btn").addEventListener("click", ()=>stopSession());

  // ── observe replies (look for tool blocks to hide + chip-insert live) ────
  function scanToolBlocks(node){
    if(!node || node.nodeType !== 1) return;
    if(A.busy) return; // don't race the active dispatch
    const candidates = [];
    if(node.tagName === "PRE") candidates.push(node);
    if(node.querySelectorAll) candidates.push(...node.querySelectorAll("pre, code"));
    for(const el of candidates){
      if(!el || el.classList.contains("rl-tool-hide")) continue;
      const txt = el.innerText || el.textContent || "";
      if(!txt || txt.indexOf("###MCP_TOOL###") === -1) continue;
      if(txt.indexOf("###MCP_TOOL###") === -1 && txt.indexOf("###LUA###") === -1) continue;
      const blk = ZSParse.extract(txt);
      if(!blk) continue;
      const n = ZSParse.normalize(blk);
      if(!n) continue;
      // Hide the raw block
      el.classList.add("rl-tool-hide");
      dispatchTool(n.name, n.arguments, el, null);
    }
  }
  function startObserver(){
    if(A.observeTarget) return;
    A.observeTarget = document.documentElement;
    const obs = new MutationObserver(muts=>{
      for(const m of muts) for(const n of m.addedNodes) scanToolBlocks(n);
    });
    try{ obs.observe(document.documentElement, {childList:true, subtree:true}); }catch{}
  }

  // ── status updates from background ───────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse)=>{
    if(!msg || !msg.type){ sendResponse({ok:false}); return; }
    if(msg.type === "rolink-status"){
      if(!msg.connected) setStatus("offline");
      else if(msg.mcpAlive && msg.studio === true) setStatus("ready");
      else if(msg.mcpAlive && msg.studio === false) setStatus("studioOff");
      else setStatus("bridge");
      sendResponse({ok:true}); return;
    }
    if(msg.type === "rolink-start"){ if(!A.started) startSession(); sendResponse({ok:true, started:A.started}); return; }
    if(msg.type === "rolink-stop"){ if(A.started) stopSession(); sendResponse({ok:true, started:A.started}); return; }
    sendResponse({ok:false});
  });
  setInterval(()=>{
    bg({type:"status"}).then(s=>{
      if(!s) return;
      if(!s.connected) setStatus("offline");
      else if(s.mcpAlive && s.studio === true) setStatus("ready");
      else if(s.mcpAlive && s.studio === false) setStatus("studioOff");
      else setStatus("bridge");
    });
    refreshTools();
  }, 3000);
  bg({type:"status"}).then(s=>{ if(s){ if(!s.connected) setStatus("offline"); else setStatus("bridge"); } });
  refreshTools();

  // Start the DOM observer (lives as long as the page does)
  startObserver();

  // expose for debug / popup
  window.ROLINK = {
    start: startSession,
    stop: stopSession,
    status: ()=>A,
    tools: ()=>A.tools,
    P,
  };
})();
