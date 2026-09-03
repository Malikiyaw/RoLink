// SPDX-License-Identifier: GPL-3.0-or-later
// core/main.js - RoLink v3.0 agentic loop + UI + camouflage (the brain).
//
// Architecture (ZeroScript-compatible, ported to RoLink):
//   - providers/*.js exports a global ZSProvider object with the site-specific
//     bits: selectors, generation detection, send mechanics, image attach.
//   - core/parser.js exposes ZSParse (pure string parser) for tool blocks.
//   - This file owns the agent loop, UI, session state, camouflage. It NEVER
//     touches the host site's DOM directly - everything goes through ZSProvider.
//   - All tool calls route through background.js (which owns the single bridge
//     WebSocket). The AI tab never opens its own WS.
//
// Loop (FSM, ported from ZeroScript v1.5.2's waitForResponse + agentLoop):
//   1. startSession(): drive the composer into agent-ready state, probe the
//      bridge + Studio, inject the real system prompt + the user's starter, send.
//   2. agentLoop(): wait for the AI's reply, classify it (tool / text / empty /
//      truncated / too-long). On tool: dispatch via bg(), replace the raw
//      block with a chip, feed the result back. On text: classify intent
//      (real answer vs "what should I build?" / "I can't run commands") and
//      react appropriately.
//   3. Live tool-block stripping: as soon as `###MCP_TOOL###` appears in the
//      DOM, hide it and show a chip. Whole-item text scan every 1.5s catches
//      multi-element blocks the per-element stripper misses.
//   4. Auto-resume watchdog: if a tool's result is dropped on the floor (AI
//      went silent), re-feed the same payload. Bounded retries, no infinite loop.
//   5. Tab-visibility gate: pause while the AI tab is hidden, resume when
//      foregrounded. Background tabs throttle rendering.
//   6. Image attach: if a tool returns images, upload them to the AI tab so
//      the model can actually SEE the result.
//   7. Session memory: persist the system prompt, conversation history, and
//      notes per conversation in chrome.storage so future sessions can
//      inherit them.
//   8. Native-tool lockdown: explicitly tell the AI to ONLY use the RoLink
//      commands, never its own built-in tools.
//   9. syncSessionState: track which conversation the loop is bound to. If
//      the user opens a NEW empty chat, abandon the loop cleanly.
//  10. Auto-inject `datamodel_type` and `studio_id` for tools that need them
//      (model never has to know these args exist).
//  11. sysResendDue: re-anchor the system prompt on the next tool result
//      every N turns (fixes the "I cannot run commands" failure on long
//      sessions).
//  12. Camouflage: hide raw tool blocks AND injected feedback turns from the
//      user's view. They see clean AI replies + tool chips only.

(function(){
  "use strict";
  if(window.__rolink_injected) return; window.__rolink_injected=true;

  const P = (typeof window !== "undefined" && window.ZSProvider) || null;
  const T = P ? P.timings : null;
  if(!P){ console.warn("[RoLink] no ZSProvider found on this page"); return; }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const log = (...a) => console.log("[rolink]", ...a);

  // ── diagnostics + trace + FSM ──────────────────────────────────────────
  const __trace = (window.__rolinkTrace) || (window.ExecutionTrace ? new window.ExecutionTrace(300) : null);
  function diag(event, data){
    try{
      const entry = { t: Date.now(), event, data };
      if(A && A.diag){ A.diag.push(entry); while(A.diag.length > 300) A.diag.shift(); }
      if(__trace) __trace.push({ ts: Date.now(), level:"info", msg: `${event} ${data?JSON.stringify(data).slice(0,120):""}` });
      if(window.console && console.debug){
        console.debug("[rolink.diag]", event, data || "");
      }
    }catch{}
  }

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

  // ── FSM + ExecutionManager (reliability overhaul) ───────────────────────
  let fsm = null;
  let execMgr = null;
  try{
    if(window.AgentFSM) fsm = new window.AgentFSM({diag, trace: __trace});
    if(window.ToolExecutionManager) execMgr = new window.ToolExecutionManager({bg, diag, trace: __trace, state: fsm});
  }catch(e){ console.warn("[rolink] fsm/exec init failed", e); }

  // ── state (ported from ZeroScript's A) ───────────────────────────────────
  const A = {
    started: false,            // user clicked Start; an active session exists
    sessionEverStarted: false, // sticky: was Start ever clicked? Used by onUserMessage hook
    starting: false,           // bootstrap in progress
    startingKey: null,         // conversation the bootstrap is bound to
    running: false,            // agent loop is running
    stopping: false,           // user clicked Stop
    loopKey: null,             // conversation the loop is bound to
    lastGenAt: 0,
    injecting: false,
    busy: false,
    toolRunning: "",
    toolStart: 0,
    feedStreak: 0,
    maxFeedStreak: 14,
    observeTarget: null,
    feedPending: null,
    lastFeedId: null,
    lastFeedAt: 0,
    lastFeedText: "",
    lastTextAt: 0,
    parked: false,
    tools: [],
    status: "offline",
    fsm,
    execMgr,
    sessionId: null,
    lastAssistantIdAtBoot: null,
    currentStudioId: null,
    userStopped: false,
    focusedDataModel: null,
    diag: [],
    startGen: 0,              // bumped on abandon so startSession's own finally is invalidated
    sentToken: null,          // identity of the assistant turn BEFORE this send (used by waitForResponse)
    bootstrapBase: null,      // assistantCount at the time of bootstrap send
    injectPreUser: null,      // userCount at the time of inject (used by preHideWholeItems)
    injectHideUntil: 0,       // one-shot pre-hide window for injected result turns
    activeTurnItem: null,     // the current assistant turn being processed
    nudgesLeft: 1,            // Q2: only self-heal cantRun once, free chat after greeting
    toolNames: new Set(),     // known tool names from the live tool list
    turnedStopped: false,     // the AI's own stop button was clicked
    stoppedAt: 0,             // timestamp of stop (for grace windows)
    strippedBlocks: new WeakSet(),
    dispatchedItems: new WeakSet(),  // message items we've already processed
  };

  // ── DOM helpers ──────────────────────────────────────────────────────────
  function el(tag, cls, html){ const e=document.createElement(tag); if(cls) e.className=cls; if(html!=null) e.innerHTML=html; return e; }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);}
  function shorten(s, n){ s=String(s); return s.length>n ? s.slice(0, n-1) + "…" : s; }

  // ── session memory (chrome.storage) ──────────────────────────────────────
  function sessionKey(){ return "rolSession_" + (A.sessionId || (location.pathname + "|" + location.hostname)); }
  function sessionIdFromUrl(){
    try{
      const p = location.pathname;
      return p.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "default";
    }catch{ return "default"; }
  }
  async function loadSession(){
    if(!bgAvailable) return;
    try{
      const r = await bg({type:"session_load", key: sessionKey()});
      if(r && r.ok && r.data){
        A.history = Array.isArray(r.data.history) ? r.data.history : [];
      }
    }catch{}
  }
  async function saveSession(){
    if(!bgAvailable) return;
    try{
      await bg({type:"session_save", key: sessionKey(), data: {
        history: (A.history || []).slice(-200),
        updatedAt: Date.now(),
      }});
    }catch{}
  }
  async function loadCustomPrompt(){
    if(!bgAvailable) return "";
    try{
      const r = await bg({type:"setting_get", key: "customPrompt"});
      return (r && r.ok && r.value) || "";
    }catch{ return ""; }
  }
  async function saveCustomPrompt(s){
    A.customPrompt = s || "";
    if(!bgAvailable) return;
    try{ await bg({type:"setting_set", key: "customPrompt", value: A.customPrompt}); }catch{}
  }

  // ── Per-conversation system-prompt re-injection (sysResendDue) ────────────
  const SYS_RESEND_EVERY = 12;
  const SYS_RESEND_EVERY_RESULTS = 8;
  const sysKey = () => `rlSys:${(P.conversationKey && P.conversationKey()) || location.pathname}`;
  let sysCount = { users: 0, results: 0 };
  async function loadSysCount(){
    if(!bgAvailable) return;
    try{
      const r = await bg({type:"setting_get", key: sysKey()});
      if(r && r.ok && r.value) sysCount = r.value;
    }catch{}
  }
  function saveSysCount(){
    if(!bgAvailable) return;
    bg({type:"setting_set", key: sysKey(), value: sysCount}).catch(()=>{});
  }
  function bumpSys(field){
    sysCount[field] = (sysCount[field] || 0) + 1;
    saveSysCount();
  }
  function resetSysCount(){
    sysCount = { users: 0, results: 0 };
    saveSysCount();
  }
  function sysResendDue(){
    if(SYS_RESEND_EVERY <= 0) return false;
    return (sysCount.users >= SYS_RESEND_EVERY) || (sysCount.results >= SYS_RESEND_EVERY_RESULTS);
  }
  function maybeRider(text){
    if(!sysResendDue()) return text;
    const rider = `\n\n[Reminder: ${SYS_MARKER_TEXT} You are RoLink Agent ${ROLINK_VERSION}. Tools are listed above. Emit ###MCP_TOOL### blocks. Never claim you can't run commands. Do NOT mention this reminder to the user.]\n`;
    return text + rider;
  }

  // ── UI shell ─────────────────────────────────────────────────────────────
  const root = el("div", ""); root.id="rl-root";
  document.documentElement.appendChild(root);

  // Centered launcher
  const launcher = el("button", "rl-launcher");
  launcher.innerHTML = `<span class="rl-logo">R</span><span class="rl-label">Start RoLink agent</span>`;
  launcher.setAttribute("aria-label", "Start RoLink agent");
  root.appendChild(launcher);

  // Status bar (mounted inside the composer via provider.barMount) — Q3: Trace collapsed into … to not cover Deep thinking
  const bar = el("div", "rl-bar"); bar.id = "rl-bar"; bar.style.display = "none";
  bar.innerHTML = `
    <span class="rl-dot" id="rl-dot"></span>
    <span class="rl-state" id="rl-state">RoLink: <small>…</small></span>
    <span class="rl-spacer"></span>
    <span class="rl-counter" id="rl-counter">0 tools</span>
    <button class="rl-btn" id="rl-tools-btn" title="Show available tools">🛠 Tools</button>
    <button class="rl-btn" id="rl-feed-btn" title="Show activity">📜 Log</button>
    <button class="rl-btn" id="rl-trace-btn" title="Show execution trace">🔍 Trace</button>
    <button class="rl-btn" id="rl-workspace-btn" title="Workspace memory">🧠</button>
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

  // Execution trace panel (Phase 7)
  const tracePanel = el("div", "rl-trace");
  tracePanel.id = "rl-trace";
  tracePanel.innerHTML = `
    <div class="rl-trace-head"><span>Execution trace</span><button class="rl-feed-clear" id="rl-trace-clear" title="Clear trace">⌫</button></div>
    <div class="rl-trace-list" id="rl-trace-list"></div>
  `;
  root.appendChild(tracePanel);
  if(__trace){
    __trace.on(e=>{
      try{
        const list = document.getElementById("rl-trace-list");
        if(!list) return;
        const row = document.createElement("div");
        row.className = "rl-trace-item " + (e.level||"info");
        const ts = new Date(e.ts).toTimeString().slice(0,8);
        row.innerHTML = `<span class="rl-trace-ts">${ts}</span><span>${escapeHtml(e.msg).slice(0,220)}</span>`;
        list.appendChild(row);
        while(list.children.length > 200) list.removeChild(list.firstChild);
        list.scrollTop = list.scrollHeight;
      }catch{}
    });
    const tc = ()=>{ const l=document.getElementById("rl-trace-list"); if(l) l.innerHTML=""; if(__trace) __trace.clear(); };
    setTimeout(()=>{ const b=document.getElementById("rl-trace-clear"); if(b) b.onclick=e=>{e.stopPropagation(); tc();}; }, 500);
  }

  // Workspace / memory panel
  const wsPanel = el("div", "rl-workspace");
  wsPanel.innerHTML = `
    <div class="rl-workspace-head">🧠 Workspace memory <button class="rl-workspace-close" id="rl-workspace-close" title="Close">×</button></div>
    <div class="rl-workspace-body">
      <div class="rl-row">
        <label>Session ID</label>
        <code id="rl-session-id">…</code>
      </div>
      <div class="rl-row">
        <label>History (this session)</label>
        <div class="rl-mem-count" id="rl-history-count">0 events</div>
      </div>
      <div class="rl-row">
        <label>Custom instructions (appended to system prompt)</label>
        <textarea id="rl-custom-prompt" placeholder="e.g. Always use the FastFlag &quot;FFlagDebugSimulatorBetaFeatures&quot; before reading the tree."></textarea>
      </div>
      <div class="rl-row">
        <button class="rl-btn primary" id="rl-save-prompt">💾 Save custom instructions</button>
        <button class="rl-btn warn" id="rl-clear-session">🗑 Clear session</button>
      </div>
    </div>
  `;
  root.appendChild(wsPanel);

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
    const list = document.getElementById("rl-tools-list"), count = document.getElementById("rl-tools-count");
    let arr = null, lastErr = null;
    for(let attempt = 0; attempt < 4; attempt++){
      try{
        const r = await bg({type:"list_tools"});
        if(r && Array.isArray(r.tools) && r.tools.length){ arr = r.tools; break; }
        lastErr = r && r.error;
      }catch(e){ lastErr = e.message; }
      await new Promise(r => setTimeout(r, 600 + attempt * 600));
    }
    A.tools = arr || [];
    A.toolNames = new Set(A.tools.map(t => (typeof t === "string") ? t : (t && t.name) || "").filter(Boolean));
    if(!list) return;
    if(!A.tools.length){
      list.textContent = lastErr ? ("bridge: " + lastErr) : "no tools — open Roblox Studio and enable MCP";
    } else {
      list.innerHTML = A.tools.map(t => {
        const nm = (typeof t === "string") ? t : (t.name || JSON.stringify(t));
        return `<span class="t" title="${escapeHtml((typeof t==="object"&&t&&t.description)||"")}">${escapeHtml(nm)}</span>`;
      }).join("");
    }
    if(count) count.textContent = A.tools.length + " available";
    return A.tools;
  }
  function wireUi(){
    document.getElementById("rl-tools-btn").onclick = e => { e.stopPropagation(); closeWorkspace(); tracePanel.classList.remove("rl-show"); toolsPanel.classList.toggle("rl-show"); };
    document.getElementById("rl-feed-btn").onclick = e => { e.stopPropagation(); closeWorkspace(); tracePanel.classList.remove("rl-show"); toolsPanel.classList.remove("rl-show"); feed.classList.toggle("rl-show"); };
    const traceBtn = document.getElementById("rl-trace-btn");
    if(traceBtn) traceBtn.onclick = e => { e.stopPropagation(); closeWorkspace(); toolsPanel.classList.remove("rl-show"); feed.classList.remove("rl-show"); tracePanel.classList.toggle("rl-show"); };
    document.getElementById("rl-feed-clear").onclick = e => { e.stopPropagation(); document.getElementById("rl-feed-list").innerHTML=""; };
    document.getElementById("rl-workspace-btn").onclick = e => {
      e.stopPropagation();
      toolsPanel.classList.remove("rl-show"); feed.classList.remove("rl-show");
      wsPanel.classList.toggle("rl-show");
      if(wsPanel.classList.contains("rl-show")) updateWorkspaceView();
    };
    document.getElementById("rl-workspace-close").onclick = e => { e.stopPropagation(); closeWorkspace(); };
    document.getElementById("rl-save-prompt").onclick = async e => {
      e.stopPropagation();
      const v = document.getElementById("rl-custom-prompt").value;
      await saveCustomPrompt(v);
      pushFeed("info", "💾", "Custom instructions saved. Will apply on next Start.");
      showBanner("Saved", "ok", 1800);
    };
    document.getElementById("rl-clear-session").onclick = async e => {
      e.stopPropagation();
      A.history = [];
      await saveSession();
      pushFeed("info", "🗑", "Session cleared");
      updateWorkspaceView();
    };
    document.addEventListener("click", e => {
      if(!wsPanel.contains(e.target) && e.target.id !== "rl-workspace-btn" && e.target.id !== "rl-settings-btn"){
        closeWorkspace();
      }
    }, true);
  }
  function closeWorkspace(){ wsPanel.classList.remove("rl-show"); }
  function updateWorkspaceView(){
    document.getElementById("rl-session-id").textContent = A.sessionId || "default";
    document.getElementById("rl-history-count").textContent = (A.history || []).length + " event" + ((A.history || []).length === 1 ? "" : "s");
    document.getElementById("rl-custom-prompt").value = A.customPrompt || "";
  }

  // Mount the bar inside the composer frame — ensure always visible even if barMount fails
  function placeBar(){
    try{
      const m = P.barMount();
      if(!m){
        // fallback: keep bar visible fixed at top-center so user sees buttons even if composer not found
        bar.style.display = "flex";
        bar.style.position = "fixed";
        bar.style.top = "48px"; bar.style.left = "50%"; bar.style.transform = "translateX(-50%)";
        bar.style.width = "auto"; bar.style.maxWidth = "90%";
        return;
      }
      if(bar.parentElement !== m.parent){ if(bar.parentElement) bar.parentElement.removeChild(bar); m.parent.insertBefore(bar, m.before || null); }
      bar.style.display = "flex";
      bar.classList.add("rl-inline");
      // keep bar compact so it doesn't overlap Deep thinking pills
      bar.style.position = "relative";
      bar.style.top = "auto"; bar.style.left = "auto"; bar.style.transform = "none";
      bar.style.margin = "0 0 6px 0"; bar.style.width = "100%";
    }catch{}
  }
  window.addEventListener("resize", placeBar);
  setInterval(placeBar, 1500);
  setTimeout(placeBar, 600);

  // ── tool chip helpers — 1000x original (head + collapsible body, category color, no copy) ──
  function getToolCategory(name){
    try{ if(typeof toolCategory==="function") return toolCategory(name); }catch{}
    try{ if(typeof window.toolCategory==="function") return window.toolCategory(name); }catch{}
    const n=(name||"").toLowerCase();
    if(/search_game_tree|inspect_instance|get_script/.test(n)) return "read";
    if(/execute_luau|create_instance|set_properties/.test(n)) return "edit";
    if(/generate_/.test(n)) return "generate";
    return "tool";
  }
  function shortArgSummary(name, args){
    if(!args || !Object.keys(args).length) return "";
    const k=Object.keys(args).slice(0,3).join(", ");
    const v=JSON.stringify(args).slice(0,80);
    return k ? `${k}: ${v}` : v;
  }
  function makeChip(name, args){
    const chip = el("div", "rl-chip");
    const cat=getToolCategory(name);
    chip.dataset.cat=cat;
    chip.dataset.t0=String(Date.now());
    const detail=shortArgSummary(name, args);
    // generationId link hint (e.g. generate_mesh -> wait_job_finished flow)
    let genHint="";
    try{
      const gid=args && (args.generationId||args.generation_id||args.id);
      if(typeof gid==="string" && gid.length>=8) genHint=` <span class="rl-gen">${escapeHtml(String(gid).slice(0,18))}</span>`;
    }catch{}
    chip.innerHTML = `<div class="rl-chip-head"><span class="rl-spinner"></span><span class="rl-ico">⚙</span><span class="rl-name">${escapeHtml(name)}</span><span class="rl-detail">${escapeHtml(detail)}</span><span class="rl-time">0s</span>${genHint}<span class="rl-chevron">▼</span></div><div class="rl-chip-body"><pre></pre><div class="rl-chip-foot"><button class="rl-copy" type="button">Copy</button><span class="rl-dur"></span></div></div>`;
    chip.querySelector(".rl-chip-head").onclick=(e)=>{ e.stopPropagation(); chip.classList.toggle("open"); };
    try{
      const pre=chip.querySelector(".rl-chip-body pre");
      const btn=chip.querySelector(".rl-copy");
      if(btn) btn.onclick=(e)=>{ e.stopPropagation(); try{ navigator.clipboard.writeText(pre?pre.textContent:""); btn.textContent="Copied"; setTimeout(()=>{btn.textContent="Copy";},1200); }catch{} };
    }catch{}
    // Live elapsed timer (ZeroScript parity: chip timer keeps ticking while running)
    try{
      const tEl=chip.querySelector(".rl-time");
      const t0=Date.now();
      const iv=setInterval(()=>{
        if(!chip.isConnected){ clearInterval(iv); return; }
        if(chip.classList.contains("rl-ok")||chip.classList.contains("rl-err")){ clearInterval(iv); return; }
        const s=((Date.now()-t0)/1000);
        if(tEl) tEl.textContent=(s<10?s.toFixed(1)+"s":Math.round(s)+"s");
      },200);
      chip._timer=iv;
    }catch{}
    return chip;
  }
  function chipFinalize(chip, name, res){
    chip.classList.remove("rl-err"); chip.classList.add(res.ok ? "rl-ok" : "rl-err");
    try{ if(chip._timer) clearInterval(chip._timer); }catch{}
    const ico=res.ok?"✓":"✗";
    const full=res.ok ? (res.text||"done") : (res.error||"failed");
    let body=full;
    if(typeof body==="string" && body.length>2000) body=body.slice(0,1960)+"… (truncated, Copy for full)";
    const secs=chip.dataset.t0?((Date.now()-Number(chip.dataset.t0))/1000):0;
    const dur=secs<10?secs.toFixed(1)+"s":Math.round(secs)+"s";
    const head=chip.querySelector(".rl-chip-head");
    if(head){
      const icoEl=head.querySelector(".rl-ico"); if(icoEl) icoEl.textContent=ico;
      const d=head.querySelector(".rl-detail"); if(d) d.textContent=shorten(String(full).replace(/\n/g," "), 120);
      const tEl=head.querySelector(".rl-time"); if(tEl) tEl.textContent=dur;
      const sp=head.querySelector(".rl-spinner"); if(sp) sp.style.display="none";
    }
    const pre=chip.querySelector(".rl-chip-body pre");
    if(pre) pre.textContent=String(body);
    const durEl=chip.querySelector(".rl-dur");
    if(durEl) durEl.textContent=(res.ok?"done in ":"failed in ")+dur;
    // Result-row semantics: collapsed result body, head shows outcome (screenshot parity)
    chip.classList.add("open");
    try{ chip.dataset.full=String(full).slice(0,8000); }catch{}
  }

  // ── THE SYSTEM PROMPT ─────────────────────────────────────────────────────
  const SYS_MARKER_TEXT = "⟪RL-SYS⟫";
  function buildSystemPrompt(){
    const tools = Array.isArray(A.tools) && A.tools.length ? A.tools : null;
    let toolBlock;
    if(tools){
      const lines = tools.map(t => {
        if(typeof t === "string") return "- " + t;
        const nm = (t && t.name) || "?";
        const schema = t.inputSchema || t.input_schema;
        if(!schema || !schema.properties) return "- " + nm;
        const req = Array.isArray(schema.required) ? schema.required : [];
        const props = Object.keys(schema.properties);
        const sig = props.length
          ? "(" + props.map(p => `${p}${req.includes(p) ? "*" : ""}`).join(", ") + ")"
          : "()";
        const desc = t.description ? " — " + String(t.description).slice(0, 100) : "";
        return `- ${nm} ${sig}${desc}`;
      });
      toolBlock = "Tools you can call (use the EXACT name; one ###MCP_TOOL### block per call; you can call multiple per reply). `*` = required.\n"
                + lines.join("\n")
                + "\n\nThe focused DataModel (" + (A.focusedDataModel || "auto-detected") + ") and studio_id are auto-injected for tools that need them. If a call fails, read the error and fix it on the next call — don't guess at unrelated tool names.";
    } else {
      // Fallback keeps grouped 111 list so AI still sees search_game_tree etc even if bridge reports 0-1 tools
      toolBlock = "Tools (111 grouped) — use EXACT names below. Studio needs bridge running (ws://127.0.0.1:17613).\n" + TOOL_NOTES + "\n\nIf bridge reports 0 tools, use fallback: get_studio_state, get_instances, find_instance, execute_luau.";
    }
    // If live list is tiny (<10) keep grouped 111 + live to avoid hiding search_game_tree
    if(tools && tools.length > 0 && tools.length < 10){
      const liveLines = tools.map(t => {
        const nm = (t && t.name) || (typeof t === "string" ? t : "?");
        return `- ${nm} (live)`;
      }).join("\n");
      toolBlock = "LIVE tools from bridge (" + tools.length + "):\n" + liveLines + "\n\nFULL 111 grouped fallback:\n" + TOOL_NOTES;
    }
    const custom = (A.customPrompt || "").trim();
    const customBlock = custom ? `\n\n# User-added instructions\n${custom}\n` : "";
    return `You are RoLink Agent ${ROLINK_VERSION} — you control Roblox Studio on the user's local PC via MCP tools.

# How to reply — pick EXACTLY ONE of these two patterns:

1) Call a tool — output a single JSON code block, EXACTLY in this format:
\`\`\`
###MCP_TOOL###
{"tool":"<name from the list below>","args":{...}}
\`\`\`
For execute_luau specifically, you can also use ###LUA### ... ###END_LUA### (no JSON escaping needed):
\`\`\`
###LUA###
<your luau code, no escaping>
###END_LUA###
\`\`\`

2) You're completely done — short final answer, end with the word DONE on its own line.

# ${toolBlock}
${customBlock}
# Rules

- GREETING ONLY ON START: After the single get_studio_state call, greet once: "Studio is connected and ready in Edit mode. What would you like to build?" then STOP and wait for the user. Do NOT auto-pick a project. Do NOT call another tool until the user gives a task.
- After greeting, wait for user — free chat. Only execute tools when the user asks.
- If a tool fails, self-heal: read the error, fix args/JSON/Luau, retry exactly once. Don't apologize and stop.
- NEVER say "I cannot run commands" or "I don't have access to your files". Your tools ARE working.
- ONLY use the tools listed above. Do NOT use any built-in code interpreter, web search, file browser, or other native tool — even if the site offers them. The Roblox MCP tools are the only thing you should call.
- Keep prose short. When fully done: one-sentence summary + DONE.`;
  }

  const STARTER = `Begin now. Do exactly ONE tool call to confirm connection, then greet and wait — no further tools until user asks.

###MCP_TOOL###
{"tool":"get_studio_state","args":{}}`;

  // ── capture send token (for stable per-turn identity) ─────────────────────
  function captureSendToken(){
    A.sentToken = P.lastAssistantId ? P.lastAssistantId() : null;
  }

  // ── transactional feed helpers ─────────────────────────────────────────
  async function waitForGenerationStart(timeoutMs){
    const t0 = Date.now();
    while(Date.now() - t0 < timeoutMs){
      try{ if(P.isGenerating && P.isGenerating()) return true; }catch{}
      await sleep(120);
    }
    return false;
  }

  async function feedToolResultTransactional(text, images){
    const preUser = (P.userCount && P.userCount()) || 0;
    A.injectPreUser = preUser;
    A.injectHideUntil = Date.now() + 3000;
    A.injecting = true;
    try{ inputCover(true); }catch{}
    if(fsm) try{ fsm.transition("FEEDING_RESULT", "feed"); }catch{}
    if(__trace) __trace.push({ ts: Date.now(), level:"info", msg:`FEEDING_RESULT ${String(text).slice(0,80)}` });
    await P.typeAndSend(text, images || []);
    // Wait for AI to actually start generating
    const started = await waitForGenerationStart(3500);
    if(!started){
      diag("feed.no_generation", { text: String(text).slice(0,80) });
      if(__trace) __trace.push({ ts: Date.now(), level:"warn", msg:"AI did not resume after feed — retrying once" });
      await sleep(800);
      try{ await P.typeAndSend(text, images || []); }catch{}
      const started2 = await waitForGenerationStart(3000);
      if(!started2){
        pushFeed("warn", "⚠", "AI did not resume after tool result — type a short message to nudge it.");
        showBanner("AI did not resume — send a short message", "warn", 5000);
        if(fsm) try{ fsm.transition("WAITING_FOR_RESUME", "no-gen"); }catch{}
      } else {
        if(fsm) try{ fsm.transition("WAITING_FOR_RESUME", "retried"); }catch{}
      }
    } else {
      if(fsm) try{ fsm.transition("WAITING_FOR_RESUME", "ok"); }catch{}
      if(__trace) __trace.push({ ts: Date.now(), level:"ok", msg:"AI generation resumed" });
    }
    // verify AI actually received result via turn growth
    await sleep(300);
    A.injecting = false;
    try{ inputCover(false); }catch{}
    if(fsm) try{ fsm.transition("WAITING_FOR_AI", "feedDone"); }catch{}
  }

  // ── dispatch a tool call (canonical, awaited, id-correlated) ────────────
  async function dispatchTool(name, args, sourceBlock, sourceItem, images){
    // Strict validation before execution: valid tool name, complete args
    if(!name || typeof name !== "string"){
      pushFeed("err","✗",`Refused dispatch: invalid tool name ${String(name)}`);
      // S8: feed the rejection reason back to the model so it self-corrects
      // instead of looping on the same broken call.
      const errRes = { ok:false, kind:"validation_error", error:"invalid tool name", text:"" };
      const feedback = `[Tool error for ${String(name) || "unknown"}]\n${errRes.error}\n\nThe valid tool names right now are: ${(A.tools||[]).map(t=>(typeof t==="string")?t:(t&&t.name)||"").filter(Boolean).slice(0,30).join(", ")}.\n\nIf you don't see the tool you want here, it is not available in this Studio; pick a different one.`;
      bumpSys("results");
      const withRider = maybeRider(feedback);
      try{ await feedToolResultTransactional(withRider, []); }catch{}
      return errRes;
    }
    // Block partially written calls: if hasOpenToolBlock true we shouldn't be here (waitForReply guards), but double-check
    if(args && typeof args === "object" && args._partial){
      pushFeed("err","✗",`Refused dispatch: partial args for ${name}`);
      const errRes = { ok:false, kind:"validation_error", error:"partial args — waiting for complete block", text:"" };
      try{ await feedToolResultTransactional(`[Tool error for ${name}]\n${errRes.error}`, []); }catch{}
      return errRes;
    }

    // S12: lazy datamodel_type injection. We read A.focusedDataModel here
    // (not at the top of the call) so a user re-focusing Studio mid-loop
    // is honoured by the next call.
    if(args && typeof args === "object"){
      if(!args.datamodel_type && A.focusedDataModel){
        // Code-bearing + instance-mutating tools need the focused DataModel.
        // RoLink names first, ZeroScript legacy aliases kept for compat.
        const NEEDS_DM = /^(execute_luau|set_script_content|create_module|add_event_handler|bind_ui_click|run_in_sandbox|run_function|get_script_content|create_instance|clone_instance|move_instance|delete_instance|set_properties|get_property_value|get_all_properties|generate_asset|import_asset|search_asset|get_snapshot|take_snapshot|multi_edit|script_read|script_grep|inspect_instance|start_stop_play|search_game_tree|set_property|get_property|get_console_output)$/i;
        if(NEEDS_DM.test(name)) args = Object.assign({}, args, { datamodel_type: A.focusedDataModel });
      }
      if(!args.studio_id && A.currentStudioId && name !== "list_roblox_studios"){
        args = Object.assign({}, args, { studio_id: A.currentStudioId });
      }
    }
    if(sourceBlock && sourceBlock.parentElement && !A.strippedBlocks.has(sourceBlock)){
      A.strippedBlocks.add(sourceBlock);
      const wrapper = sourceBlock.parentElement;
      if(wrapper && wrapper !== sourceItem){
        wrapper.style.display = "none";
        wrapper.classList.add("rl-tool-hide-wrap");
      } else {
        sourceBlock.style.display = "none";
        sourceBlock.classList.add("rl-tool-hide");
      }
    }
    const chip = makeChip(name, args);
    // S11: multi-call chip placement. If this is the Nth call in a single
    // assistant reply, anchor chips after the previous one instead of into
    // the shared assistant bubble.
    const spot = (P && P.findToolBlockSpot)
      ? P.findToolBlockSpot(sourceItem, chip)
      : null;
    if(spot && spot.parent){
      spot.parent.insertBefore(chip, spot.ref || null);
    } else if(sourceBlock && sourceBlock.parentElement && sourceBlock.parentElement.parentElement){
      sourceBlock.parentElement.parentElement.insertBefore(chip, sourceBlock.parentElement);
    } else {
      (sourceBlock || document.body).appendChild(chip);
    }
    A.busy = true; A.toolRunning = name; A.toolStart = Date.now();
    if(fsm) try{ fsm.transition("TOOL_DETECTED", name); }catch{}
    pushFeed("tool", "⚙", `${name} ${JSON.stringify(args).slice(0,180)}`);
    if(__trace) __trace.push({ ts: Date.now(), level:"info", msg:`TOOL_DETECTED ${name}` });
    setCounter(++A.toolCount);
    // S9: history with provenance
    const callStart = Date.now();
    const callEntry = {role:"tool_call", name, args, ts:callStart, sourceItem: sourceItem ? "yes" : "no"};
    (A.history = A.history || []).push(callEntry);
    saveSession();

    // Determine timeout: layered timeouts
    let timeout = 120000;
    if(name === "execute_luau") timeout = 20000;
    if(fsm) try{ fsm.transition("EXECUTING_TOOL", name); }catch{}

    let res;
    const sessionId = A.sessionId || (P.conversationKey ? P.conversationKey() : location.pathname);
    const turnId = A.sentToken || null;
    // S10: try/catch around the whole execute path. A bridge timeout that
    // used to kill the loop (e.g. a Studio crash during a 30-line multi_edit)
    // is now a structured error the model can self-correct from.
    try {
      if(execMgr){
        res = await execMgr.execute({name, arguments: args}, { sessionId, turnId, timeout, getSessionId: ()=> A.sessionId || (P.conversationKey?P.conversationKey():location.pathname) });
        // Handle stale: don't feed into new chat
        if(res && res.stale){
          chipFinalize(chip, name, {ok:false, error:"Result arrived for previous chat — not injecting."});
          pushFeed("warn","↻",`${name}: stale result discarded (new chat opened)`);
          A.busy = false; A.toolRunning = "";
          if(fsm) try{ fsm.transition("WAITING_FOR_AI", "stale"); }catch{}
          return {chip, name, res, text: res.text||"", stale:true};
        }
      } else {
        // Fallback direct bg path (should not happen)
        res = await bg({type:"call_tool", name, arguments: args, timeout, sessionId, turnId});
        if(!res) res = {ok:false, error:"no response from bridge", kind:"bridge_offline"};
      }
    } catch(e){
      // S10: never let a thrown exception kill the loop.
      const msg = String(e && e.message || e);
      res = { ok:false, kind:"exception", error: msg, text:"" };
      pushFeed("err", "✗", `${name}: EXCEPTION ${msg.slice(0,200)}`);
    }

    A.busy = false; A.toolRunning = "";
    if(!res) res = {ok:false, error:"no response from bridge", kind:"bridge_offline"};
    if(res.kind === "stale-extension" || isContextInvalidated(res.error)){
      chipFinalize(chip, name, {ok:false, error:"Extension updated — please reload this page and click Start again."});
      pushFeed("err", "✗", "Extension context invalidated. Reload the page.");
      A.running = false; setLauncherStopped();
      if(fsm) try{ fsm.transition("ERROR", "contextInvalidated"); }catch{}
      return {chip, name, res, text: ""};
    }
    chipFinalize(chip, name, res);
    const text = res.ok ? (res.text || "OK") : ("ERROR: " + (res.error || "unknown"));
    const ok = res.ok !== false;
    pushFeed(ok ? "ok" : "err", ok ? "✓" : "✗", `${name}: ${shorten(String(text).replace(/\n/g," "), 200)}`);
    if(__trace) __trace.push({ ts: Date.now(), level: ok?"ok":"error", msg:`${ok?"✓":"✗"} ${name}: ${String(text).slice(0,100)}` });
    // S9: result provenance
    (A.history = A.history || []).push({role:"tool_result", name, ok, text, ts:Date.now(), durationMs: Date.now()-callStart, kind: res.kind||(ok?"success":"error")});
    saveSession();
    // Drift detection: a successful call resets the per-provider counter.
    try{ if(typeof window !== "undefined" && window.__rolinkDrift && window.__rolinkDrift.noteSuccessfulTool) window.__rolinkDrift.noteSuccessfulTool(P.id || "generic"); }catch{}
    if(name === "get_studio_state" && ok){
      const m = String(text).match(/Focused DataModel in the viewport:\s*(\w+)/i)
             || String(text).match(/Available DataModels:\s*(\w+)/i);
      if(m && m[1]) A.focusedDataModel = m[1];
    }
    if(name === "list_roblox_studios" && ok){
      try{
        const j = JSON.parse(text);
        const studios = j && (j.studios || j);
        if(Array.isArray(studios) && studios.length && studios[0] && studios[0].id){
          A.currentStudioId = studios[0].id;
          pushFeed("info", "🎯", `Studio: ${studios[0].name || studios[0].id} (auto-injected)`);
        }
      }catch{}
    }
    const imgs = (res && res.images && res.images.length) ? res.images : null;
    A.lastFeedText = text; A.lastFeedAt = Date.now(); A.lastFeedId = name + ":" + Date.now();
    const textForModel = text.length > 12000 ? text.slice(0, 11500) + "\n\n[…result truncated for context; full result is in the chip above…]" : text;
    let hint = "";
    if(!ok){
      if(/unknown tool/i.test(text) && Array.isArray(A.tools) && A.tools.length){
        hint += `\n\nThe valid tool names right now are: ${A.tools.map(t => (typeof t==="string")?t:(t&&t.name)||"").filter(Boolean).join(", ")}.`;
      }
      const required = String(text).match(/['"]?(\w+)['"]? is required/i);
      if(required){
        const toolSchema = Array.isArray(A.tools) ? A.tools.find(t => t && t.name === name) : null;
        const schema = toolSchema && (toolSchema.inputSchema || toolSchema.input_schema);
        if(schema && schema.properties){
          const props = Object.entries(schema.properties).map(([k,v]) => {
            const isReq = (schema.required || []).includes(k);
            return `${k}${isReq ? " (required)" : ""}: ${v.type || "any"} — ${(v.description || "").slice(0,80)}`;
          }).join("\n  ");
          hint += `\n\nThe "${name}" tool requires these arguments:\n  ${props}\n\nYou were missing: "${required[1]}".`;
        } else {
          hint += `\n\nThe "${name}" tool is missing a required argument: "${required[1]}". Check the tool's schema.`;
        }
      }
    }
    // Q1/Q2: greeting-per-click-start — first tool (get_studio_state) feeds greeting-only prompt, no "You MUST continue" / "Don't ask ACT"
    const isGreetingTool = (name === "get_studio_state" && A.toolCount <= 1 && ok);
    const feedbackMsg = isGreetingTool
      ? `[Tool result for ${name}]\n${textForModel}\n\nRespond with a short greeting only: "Studio is connected and ready in Edit mode. What would you like to build?" Then wait for the user. Do NOT call another tool now.`
      : ok
        ? `[Tool result for ${name}]\n${textForModel}`
        : `[Tool error for ${name}]\n${text}\n\nThe tool call failed. Self-heal: fix args/JSON/Luau and retry once with correct ###MCP_TOOL###. ${hint}`;
    bumpSys("results");
    const withRider = maybeRider(feedbackMsg);
    // Transactional feeding: hidden injection (camouflaged), not visible user bubble — free chat
    await feedToolResultTransactional(withRider, imgs || []);
    return {chip, name, res, text};
  }

  // ── detect "AI is asking the user a question" ──────────────────────────────
  function looksLikeAQuestion(text){
    if(!text) return false;
    const t = text.trim();
    if(!t) return false;
    if(t.length < 400 && /\?[\s]*$/.test(t) && !/###MCP_TOOL###/.test(t) && !/###LUA###/.test(t)) return true;
    if(/what (do you|would you|should I|can I).{0,40}(build|create|make|do|help|want)/i.test(t)) return true;
    if(/how can I (help|assist)/i.test(t)) return true;
    if(/I('?m| am) (ready|waiting|here to help)/i.test(t) && /\?/.test(t)) return true;
    if(/what('?s| is) (your|the) (goal|task|request|project|idea)/i.test(t)) return true;
    if(/could you (tell|provide|share|give|clarify)/i.test(t)) return true;
    if(/please (specify|clarify|provide|tell me)/i.test(t)) return true;
    if(/I('?ll| will) await/i.test(t)) return true;
    return false;
  }
  function looksLikeCantRun(text){
    if(!text) return false;
    return /I (can'?t|cannot|don'?t have|do not have|am unable to|unable to) (run|execute|invoke|use|call|access).{0,40}(command|tool|code|script|function|file)/i.test(text)
        || /I don'?t have access to (your|the) (computer|file|system|studio|project)/i.test(text)
        || /I (can'?t|cannot) (directly )?(interact|control|modify) (your|the) (studio|project|game|file)/i.test(text)
        || /(there is no|there are no) (way|method) (for me|to).{0,30}(run|execute|invoke|call|use)/i.test(text);
  }

  // ── send the user's starter request (after system prompt) ────────────────
  function sendSystemPromptAndStarter(){
    const first = buildSystemPrompt() + "\n\n---\n\n" + STARTER;
    (A.history = A.history || []).push({role:"user", text: first, ts:Date.now()});
    saveSession();
    setLauncherRunning();
    return submitAndGetBase(first, []).then(base => {
      A.bootstrapBase = base;
      A.starting = false;
      A.loopKey = P.conversationKey ? P.conversationKey() : location.pathname;
      A.running = true;
      A.feedStreak = 0;
      A.nudgesLeft = 1;
      A.lastAssistantIdAtBoot = P.lastAssistantId ? P.lastAssistantId() : null;
      pushFeed("info", "▶", "Agent loop started. Greeting — then free chat…");
      showBanner("Agent running. Waiting for greeting — then free chat.", "ok", 5000);
      agentLoop(base);
    }).catch(e=>{
      A.starting = false; A.started = false;
      pushFeed("err", "✗", "Could not send system prompt: " + e.message);
      setLauncherStopped();
    });
  }

  // ── submitAndGetBase: reliable send with retry + textarea-clear detect ─
  // Ported from ZeroScript. The site clears the textarea as soon as the send
  // is accepted; that's our primary fast gate. The assistantCount check is
  // the fallback for long chats where list virtualization keeps counts flat.
  async function submitAndGetBase(text, images){
    captureSendToken();
    diag("send", { text: String(text).slice(0, 60), busy: P.isBusyNow && P.isBusyNow() });
    A.injecting = true;
    inputCover(true);
    try{
      // Quick 2-point settle: sample the previous response's stream length
      // before and after a 200ms yield. A one-shot React batch flush shows no
      // growth and costs only 200ms. A still-generating stream shows growth
      // → fall back to the full idle wait.
      const settleItem = P.lastAssistant && P.lastAssistant();
      const settleLen0 = settleItem ? (P.streamLen ? P.streamLen(settleItem) : 0) : 0;
      await sleep(200);
      if(settleItem && settleItem === P.lastAssistant() && P.streamLen && P.streamLen(settleItem) > settleLen0){
        // Still generating; wait for it to stop
        await waitFor(() => !P.isGenerating(), 4000);
      }
      const base = P.assistantCount();
      const preUser = (P.userCount && P.userCount()) || 0;
      A.injectPreUser = preUser;
      A.injectHideUntil = Date.now() + 2500;
      const landed = () => (P.userCount && P.userCount() > preUser) || (P.assistantCount && P.assistantCount() > base);
      // CRITICAL: never type/send while the tab is HIDDEN. Background tabs
      // throttle rendering, which made landed-check unreliable.
      let tries = 0, messageSent = false;
      const myGen = A.startGen;
      while(!messageSent && !landed() && tries < 4 && A.startGen === myGen && !A.stopping){
        if(document.hidden){
          if(!(await waitForVisible()) || A.stopping) break;
        }
        await jitterBeforeSend();
        diag("submit.typeAndSend", { hasImages: !!(images && images.length) });
        await P.typeAndSend(text, images);
        // Re-arm the pre-hide window NOW that typeAndSend has returned.
        A.injectHideUntil = Date.now() + 2500;
        // Fast gate: textarea cleared = send accepted.
        const ok = await waitFor(() => {
          if(P.editorText && P.editorText().trim() === "") return true;
          return landed();
        }, 3500);
        if(ok) messageSent = true;
        tries++;
      }
      if(!messageSent && !landed() && A.startGen === myGen && !A.stopping){
        diag("send.failed", { tries });
        pushFeed("err", "✗", `${P.displayName} did not accept the injected message after ${tries} attempts. Send a short message yourself to resume.`);
        showBanner("Send failed — type a short message to resume", "warn", 6000);
      }
      return base;
    }finally{
      if(!A.starting && !A.running) inputCover(false);
      setTimeout(() => (A.injecting = false), 400);
      setTimeout(preHideWholeItems, 200);
      setTimeout(preHideWholeItems, 700);
    }
  }
  async function waitFor(pred, timeout){
    const t0 = Date.now();
    while(Date.now() - t0 < timeout){
      try{ if(pred()) return true; }catch{}
      await sleep(50);
    }
    return false;
  }
  function jitterBeforeSend(){
    return new Promise(r => setTimeout(r, 30 + Math.random() * 70));
  }
  async function waitForVisible(){
    if(!document.hidden || A.stopping) return Promise.resolve(!A.stopping);
    A.parked = true; pushFeed("info", "⏸", "Tab hidden — paused");
    return new Promise(resolve=>{
      const done = () => { document.removeEventListener("visibilitychange", onVis); clearInterval(iv); A.parked = false; if(!A.stopping) pushFeed("info", "▶", "Resumed"); resolve(!A.stopping); };
      const onVis = () => { if(!document.hidden) done(); };
      document.addEventListener("visibilitychange", onVis);
      const iv = setInterval(() => { if(A.stopping || !document.hidden) done(); }, 500);
    });
  }

  // ── visibility gate (pause while the AI tab is hidden) ──────────────────
  function waitForVisible_old(){
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
  function agentLoop(base){
    if(A.stopping){ A.running = false; setLauncherStopped(); return; }
    (async function tick(){
      while(A.running && !A.stopping){
        if(document.hidden){
          await waitForVisible();
          if(A.stopping) break;
        }
        const reply = await waitForReply(base);
        if(A.stopping) break;
        if(reply.kind === "tool"){
          A.feedStreak = 0;
          A.nudgesLeft = 1;
          if(fsm) try{ fsm.transition("TOOL_DETECTED", `${reply.calls.length} calls`); }catch{}
          // SEQUENTIAL await — never concurrent chaos. Each tool must complete before next.
          for(const c of reply.calls){
            if(A.stopping) break;
            // Visibility gate per-tool
            if(document.hidden){
              await waitForVisible();
              if(A.stopping) break;
            }
            // Check staleness: new chat opened while waiting?
            const curKey = P.conversationKey ? P.conversationKey() : location.pathname;
            if(A.loopKey && curKey !== A.loopKey){
              diag("tool.stale_session", { loopKey: A.loopKey, curKey });
              pushFeed("warn","↻","New chat opened — abandoning pending tools");
              break;
            }
            // c is the normalised call from the parser; canonical fields are
            // .tool / .args. The parser also exposes .name / .arguments
            // aliases (see parser.js normalize()) so either form works here.
            await dispatchTool(c.tool, c.args, null, reply.item);
          }
        } else if(reply.kind === "text"){
          // Q1: delete "Don't ask ACT" nudge — free chat after greeting. Only self-heal cantRun (once)
          if(looksLikeCantRun(reply.text) && A.nudgesLeft > 0 && A.toolCount > 0){
            A.nudgesLeft--;
            pushFeed("warn", "↻", `AI claimed it can't run tools (${1 - A.nudgesLeft}/1) — re-grounding (self-heal)`);
            A.injecting = true;
            try{ inputCover(true); }catch{}
            await P.typeAndSend(`You DO have tools. They are listed in your system prompt and have been used successfully in this session. Re-read your system prompt. The valid tool names are: ${(A.tools||[]).map(t=>(typeof t==="string")?t:(t&&t.name)||"").filter(Boolean).join(", ")}. Emit a ###MCP_TOOL### block now using one of these exact names.`, []);
            try{ inputCover(false); }catch{}
            A.injecting = false;
            continue;
          }
          pushFeed("done", "🏁", `Agent finished (${A.toolCount} tool call${A.toolCount === 1 ? "" : "s"}).`);
          A.running = false;
          // Keep A.started true so onUserMessage re-arms on next user message.
          setLauncherStopped();
          showBanner("Agent finished. Type your next request to re-arm.", "ok", 5000);
          return;
        } else if(reply.kind === "truncated"){
          if(P.clickContinueBtn && P.clickContinueBtn()){ pushFeed("info", "↻", "Clicked Continue (truncated reply)"); continue; }
          A.injecting = true;
          try{ inputCover(true); }catch{}
          await P.typeAndSend("Your last reply was truncated. Please redo the tool call (or final answer) in full. Do not include ###END markers or closing fences you don't need.", []);
          try{ inputCover(false); }catch{}
          A.injecting = false;
        } else if(reply.kind === "empty"){
          A.feedStreak++;
          if(A.feedStreak > A.maxFeedStreak){
            pushFeed("err", "⏹", `Gave up after ${A.maxFeedStreak} empty replies. Click Start to try again.`);
            A.running = false;
            setLauncherStopped();
            return;
          }
          if(A.lastFeedText && (Date.now() - A.lastFeedAt) < 60000){
            pushFeed("info", "↻", `Empty reply — re-feeding last result (${A.feedStreak}/${A.maxFeedStreak})`);
            A.injecting = true;
            try{ inputCover(true); }catch{}
            await P.typeAndSend(`[No reply received. Reminder: the last tool result was]\n${A.lastFeedText}\n\nPlease continue. Either call another tool via ###MCP_TOOL### or give a final answer ending with DONE.`, []);
            try{ inputCover(false); }catch{}
            A.injecting = false;
          } else {
            A.injecting = true;
            try{ inputCover(true); }catch{}
            await P.typeAndSend("Please continue. Use ###MCP_TOOL### {json} to call a tool, or end with DONE when finished.", []);
            try{ inputCover(false); }catch{}
            A.injecting = false;
          }
        } else if(reply.kind === "parse_error"){
          pushFeed("err", "✗", "Malformed tool call — sending fix-it nudge");
          A.injecting = true;
          try{ inputCover(true); }catch{}
          const targetTool = (reply.raw && ZSParse.toolNameFromText(reply.raw)) || "execute_luau";
          // SUPER-POWERFUL: tool-specific nudge with visible example for the failing tool
          let toolNudge = "";
          if(["multi_edit"].includes(targetTool)){
            // Q1 stay if needed — powerful for edits[].new_text AND edits[].new_string/old_string (your double-check)
            toolNudge = `For multi_edit, every new_text / new_string / old_string MUST escape " as \\" and newline as \\n. Example (one line):

###MCP_TOOL###
{"tool":"multi_edit","args":{"file_path":"Workspace.Zombie.ZombieCore","edits":[{"action":"replace_lines","start_line":26,"end_line":33,"new_text":"local Players = game:GetService(\\"Players\\")\\nlocal function getNearestPlayer()\\n\\treturn nearest\\nend"}]}}

Example with old_string/new_string (your double-check, stay if needed):
###MCP_TOOL###
{"tool":"multi_edit","args":{"file_path":"Workspace.Zombie.ZombieCore","edits":[{"old_string":"local holder = Instance.new(\\"BodyPosition\\")","new_string":"humanoid.WalkSpeed = 6\\nlocal Players = game:GetService(\\"Players\\")"}]}}

Super powerful: you can also do multiple single-line execute_luau via ###LUA### instead of one huge multi_edit (Q2 if needed).`;
          } else if(["execute_luau","run_in_sandbox","review_code","refactor_code","generate_test","analyze_performance","predict_bug"].includes(targetTool)){
            toolNudge = `For ${targetTool} code strings you MUST either escaped JSON OR ###LUA### (super powerful, no escaping):

JSON escaped (one line):
###MCP_TOOL###
{"tool":"${targetTool}","args":{"code":"local p = Instance.new(\\"Part\\"); p.Parent = game.Workspace; print(\\"hi\\")"}}

Super powerful ###LUA###:
###LUA###
local p = Instance.new("Part")
p.Parent = game.Workspace
print("hi")
###END_LUA###`;
          } else if(["set_script_content","create_module"].includes(targetTool)){
            toolNudge = `For ${targetTool} use: {"tool":"${targetTool}","args":{"path":"Workspace/Script","content":"local x=1\\nprint(\\"hi\\")"}} — escape " as \\" and newline as \\n.`;
          } else {
            toolNudge = `Fix JSON: escape every " inside strings as \\" and use \\n for newlines. Example: {"tool":"${targetTool}","args":{"code":"local p = Instance.new(\\"Part\\")"}} or use ###LUA### for Luau.`;
          }
          await P.typeAndSend(`Your last tool call was malformed JSON (${reply.reason}) for tool ${targetTool}.

${toolNudge}

Super powerful alternative: use ###LUA### ... ###END_LUA### for ANY Luau (no escaping):

Retry now with valid JSON (or use the ###LUA### form).`, []);
          try{ inputCover(false); }catch{}
          A.injecting = false;
        } else if(reply.kind === "context_limit"){
          pushFeed("err", "⏹", "Context limit reached: " + (reply.detail||"").slice(0,200));
          A.running = false;
          setLauncherStopped();
          showBanner("Context limit reached. Open a new chat and click Start again.", "err", 8000);
          return;
        } else if(reply.kind === "too_long"){
          A.injecting = true;
          try{ inputCover(true); }catch{}
          await P.typeAndSend("Your reply exceeded the model's context window. Please start a new chat (click the '+' / new chat button) and re-send your last request. I'll resume from there.", []);
          try{ inputCover(false); }catch{}
          A.injecting = false;
        } else if(reply.kind === "stopped" || reply.kind === "timeout"){
          A.running = false;
          setLauncherStopped();
          pushFeed("info", "⏸", "Agent stopped: " + reply.kind);
          return;
        }
      }
    })().catch(e=>{
      console.error("[rolink] loop error", e);
      pushFeed("err", "✗", "Loop crashed: " + (e && e.message || e));
      A.running = false;
      setLauncherStopped();
    });
  }

  // ── wait for the AI to finish a reply, then classify ──────────────────────
  // Defensive FSM with lastGoodReply, stuckDone, genFlickers, effectiveBlock.
  async function waitForReply(base){
    const TIMEOUT = (T && T.RESPONSE_TIMEOUT_MS) || 300000;
    const t0 = Date.now();
    const STABLE_MS = (T && T.STABLE_MS) || 9000;
    const WARMUP_MS = (T && T.WARMUP_MS) || 30000;
    const REASON_NOREPLY_MS = (T && T.REASON_NOREPLY_MS) || 60000;
    const GEN_STOP_GRACE_MS = 2500;
    const UNSETTLED_GRACE_MS = 8000;
    const NO_TURN_GRACE_MS = 30000;

    let lastActive = Date.now();
    let started = false, doneSince = 0;
    let lastText = null, lastChange = Date.now();
    let genFalseSince = 0, genOffFirstAt = 0, prevGen = null, genFlickers = 0;
    let warmSince = 0, reasonSince = 0, noTurnSince = 0, unsettledSince = 0;
    let curItem = null, lastGoodReply = "";
    const lastSeenAssistantId = A.sentToken;
    const baseline = (typeof base === "number") ? base : (A.bootstrapBase || 0);

    while(Date.now() - lastActive < TIMEOUT){
      if(A.stopping) return {kind:"stopped"};

      if(document.hidden){
        const parked = await waitForVisible();
        if(A.stopping) return {kind:"stopped"};
        lastActive += 500;
        lastChange += 500;
        if(genFalseSince) genFalseSince += 500;
        if(warmSince) warmSince += 500;
        if(reasonSince) reasonSince += 500;
        if(noTurnSince) noTurnSince += 500;
        if(unsettledSince) unsettledSince += 500;
        if(genOffFirstAt) genOffFirstAt += 500;
        continue;
      }

      const gen = P.isGenerating();
      if(gen) lastActive = Date.now();
      const d = P.readAssistant();
      const replyText = (d && d.reply) || "";
      const replyNorm = replyText.replace(/\s+/g, " ").trim();
      if(replyNorm !== lastText){ lastText = replyNorm; lastChange = Date.now(); lastActive = Date.now(); }

      if(gen) genFalseSince = 0;
      else if(!genFalseSince) genFalseSince = Date.now();
      if(started && !gen && !genOffFirstAt) genOffFirstAt = Date.now();
      if(prevGen === false && gen && genOffFirstAt) genFlickers++;
      prevGen = gen;

      if(d.item !== curItem){ curItem = d.item; warmSince = 0; lastGoodReply = ""; }
      if(replyText && replyText.length) lastGoodReply = replyText;

      const curTok = P.lastAssistantId ? P.lastAssistantId() : undefined;
      const newTurn = (curTok !== undefined && curTok !== null)
        ? (curTok !== lastSeenAssistantId)
        : (P.assistantCount && P.assistantCount() > baseline);

      if(!started){
        const hasText = !!replyText.length;
        if(gen || (newTurn && hasText)){ started = true; }
        else {
          if(!warmSince) warmSince = Date.now();
          if(Date.now() - warmSince > 60000) return {kind:"empty"};
          await sleep(200); continue;
        }
      }

      const ctx = P.scanError && P.scanError();
      if(ctx) return {kind:"context_limit", detail: ctx};

      const blockActive = ZSParse.hasOpenToolBlock(replyText) && Date.now() - lastChange < 6000;
      const genStopped = !gen && genFalseSince && Date.now() - genFalseSince > GEN_STOP_GRACE_MS;
      const effectiveBlock = blockActive && !genStopped;

      const stuckDone = started && replyText && Date.now() - lastChange > STABLE_MS &&
        !(gen && ZSParse.hasOpenToolBlock(replyText));

      if((gen || effectiveBlock) && !stuckDone){
        doneSince = 0;
        await sleep(160);
        continue;
      }

      if(P.reliableCounts && !newTurn){
        if(!noTurnSince) noTurnSince = Date.now();
        if(Date.now() - noTurnSince < NO_TURN_GRACE_MS){ await sleep(200); continue; }
      } else {
        noTurnSince = 0;
      }

      if(!doneSince) doneSince = Date.now();
      if(Date.now() - doneSince < 500){ await sleep(120); continue; }

      if(!replyText.trim() && !lastGoodReply){
        if(!warmSince) warmSince = Date.now();
        if(Date.now() - warmSince < WARMUP_MS){ await sleep(200); continue; }
        return {kind:"empty"};
      }

      if(d.thinking && d.thinking.length && !replyText.length && !(P.turnHalted && P.turnHalted(d.item))){
        if(!reasonSince) reasonSince = Date.now();
        if(Date.now() - reasonSince < REASON_NOREPLY_MS){ await sleep(200); continue; }
      } else {
        reasonSince = 0;
      }

      let r = replyText;
      if(!r && lastGoodReply) r = lastGoodReply;

      if(r.length < 400 && P.isTooLongMsg && P.isTooLongMsg(r)) return {kind:"too_long", text: r};

      if(P.isComparisonTurn && P.isComparisonTurn(d.item)){
        if(P.isGenerating()){ await sleep(250); continue; }
        if(P.resolveComparison && P.resolveComparison()){
          await sleep(400); continue;
        }
        await sleep(250); continue;
      }

      const cmdShaped = P.replyUnsettled && (
        ZSParse.hasToolSignature(r) ||
        (ZSParse.LUA_END_RE && ZSParse.LUA_END_RE.test(r) && ZSParse.LUA_START_RE && !ZSParse.LUA_START_RE.test(r)) ||
        (/"(?:datamodel_type|edits|old_string|new_string|file_path|target_file)"\s*:/.test(r) &&
          !/"command"\s*:/.test(r))
      );
      if(cmdShaped && P.replyUnsettled(d.item)){
        if(!unsettledSince) unsettledSince = Date.now();
        if(Date.now() - unsettledSince < UNSETTLED_GRACE_MS){ await sleep(250); continue; }
      } else {
        unsettledSince = 0;
      }

      if(ZSParse.hasToolSignature(r)){
        const calls = ZSParse.extractAll(r).filter(Boolean);
        if(calls.length){
          return {kind:"tool", calls, item: d.item, lastId: curTok};
        }
        if(P.findContinueBtn && P.findContinueBtn()) return {kind:"truncated", text: r, item: d.item};
        if(r.indexOf(ZSParse.START_M) !== -1 || (ZSParse.LUA_START_RE && ZSParse.LUA_START_RE.test(r))){
          return {kind:"parse_error", reason:"malformed", raw: r, item: d.item};
        }
        if(ZSParse.hasOpenToolBlock(r)){
          const salvaged = ZSParse.salvageCutOff ? ZSParse.salvageCutOff(r) : null;
          if(salvaged){
            pushFeed("info", "↻", "Salvaged cut-off tool call: " + (salvaged.tool || salvaged.name || "?"));
            return {kind:"tool", calls: [salvaged], item: d.item, lastId: curTok};
          }
          return {kind:"parse_error", reason:"unclosed", raw: r, item: d.item};
        }
        const nm = ZSParse.toolNameFromText ? ZSParse.toolNameFromText(r) : null;
        if(nm && nm !== "command" && A.toolNames && (A.toolNames.has(nm) || A.toolNames.has(nm.replace(/^.*\//, "")))){
          return {kind:"parse_error", reason:"malformed", raw: r, item: d.item};
        }
      }

      if(ZSParse.LUA_END_RE && ZSParse.LUA_END_RE.test(r) &&
         ZSParse.LUA_START_RE && !ZSParse.LUA_START_RE.test(r) &&
         r.indexOf(ZSParse.START_M) === -1){
        return {kind:"parse_error", reason:"luaOpener", raw: r, item: d.item};
      }

      if(/"(?:datamodel_type|edits|old_string|new_string|file_path|target_file)"\s*:/.test(r) &&
         !/"command"\s*:/.test(r)){
        return {kind:"parse_error", reason:"envelope", raw: r, item: d.item};
      }

      if(!r.trim()) return {kind:"empty"};
      return {kind:"text", text: r, item: d.item};
    }
    return {kind:"timeout"};
  }

  // ── launcher click: start a session ──────────────────────────────────────
  async function startSession(){
    if(A.started) return;
    const myGen = ++A.startGen;
    A.started = true; A.sessionEverStarted = true; A.starting = true; A.running = false; A.stopping = false;
    A.feedStreak = 0; A.toolCount = 0; A.lastFeedText = ""; A.lastFeedAt = 0; A.lastFeedId = null;
    A.nudgesLeft = 1; A.strippedBlocks = new WeakSet(); A.dispatchedItems = new WeakSet();
    setCounter(0);
    document.getElementById("rl-feed-list").innerHTML = "";
    launcher.classList.add("is-active", "is-starting");
    launcher.innerHTML = `<span class="rl-spinner-inline"></span><span class="rl-label">Starting up…</span>`;
    document.getElementById("rl-stop-btn").style.display = "inline-flex";
    pushFeed("info", "⏳", `Agent starting up on ${location.hostname} — waiting for AI greeting…`);
    showBanner("Starting up — AI will say I'm ready…", "ok", 3500);
    placeBar();
    try{
      const s = await bg({type:"status"});
      if(!s || !s.connected){
        pushFeed("err", "✗", "Bridge not connected. Run start.bat to activate the bridge.");
        showBanner("Bridge offline — run start.bat", "err", 6000);
        if(myGen !== A.startGen) return;
        A.started = false; A.starting = false;
        setLauncherStopped();
        return;
      }
      if(!s.mcpAlive){
        pushFeed("warn", "⚠", "Bridge up but no MCP server. Open Roblox Studio and enable 'Studio as MCP server'.");
        showBanner("Open Roblox Studio + enable MCP", "warn", 6000);
      } else {
        pushFeed("ok", "✓", `Bridge connected · ${(s.tools || 0)} tools · Studio ${s.studio ? "ready" : "not connected"}`);
      }
    }catch{}
    if(P.ensureComposerReady){
      try{
        const s = await P.ensureComposerReady("startup");
        if(!s.ready){
          pushFeed("err", "⏹", "Composer not ready (no model selected). Pick Expert/Instant/Vision and try again.");
          if(myGen !== A.startGen) return;
          A.started = false; A.starting = false; setLauncherStopped(); return;
        }
      }catch{}
    }
    if(myGen !== A.startGen) return; // user opened a new chat mid-bootstrap
    A.sessionId = sessionIdFromUrl();
    await loadSession();
    A.customPrompt = await loadCustomPrompt();
    await loadSysCount();
    A.startingKey = P.conversationKey ? P.conversationKey() : location.pathname;
    A.lastAssistantIdAtBoot = P.lastAssistantId ? P.lastAssistantId() : null;
    // Mandatory tool discovery before first build request (Phase 8)
    let discovered = [];
    try{ discovered = await refreshTools(); }catch{}
    if(!discovered || !discovered.length){
      // Retry once with live probe
      try{ discovered = await refreshTools(); }catch{}
    }
    if(!discovered || !discovered.length){
      pushFeed("err","✗","RoLink connected, but Roblox Studio tools are unavailable. Open Studio → Enable MCP, then click Start again.");
      showBanner("No Studio tools — enable MCP in Studio", "err", 6000);
      if(fsm) try{ fsm.transition("ERROR", "no-tools"); }catch{}
      if(myGen !== A.startGen) return;
      A.started = false; A.starting = false; setLauncherStopped();
      return;
    }
    if(fsm) try{ fsm.transition("WAITING_FOR_AI", "toolsReady"); }catch{}
    if(__trace) __trace.push({ ts: Date.now(), level:"ok", msg:`Tools discovered: ${discovered.length} — building system prompt` });
    // Auto-probe: discover the focused DataModel and current studio
    try{
      const r = await bg({type:"call_tool", name: "get_studio_state", arguments: { studio_id: A.currentStudioId || "" }, timeout: 10000});
      if(r && r.ok && r.text){
        const m = String(r.text).match(/Focused DataModel in the viewport:\s*(\w+)/i)
               || String(r.text).match(/Available DataModels:\s*(\w+)/i);
        if(m && m[1]){
          A.focusedDataModel = m[1];
          pushFeed("info", "🎯", `Focused DataModel: ${A.focusedDataModel} (auto-injected into tool args)`);
        }
      }
    }catch{}
    try{
      const r2 = await bg({type:"call_tool", name: "list_roblox_studios", arguments: {}, timeout: 10000});
      if(r2 && r2.ok && r2.text){
        try{
          const j = JSON.parse(r2.text);
          const studios = j && (j.studios || j);
          if(Array.isArray(studios) && studios.length && studios[0] && studios[0].id){
            A.currentStudioId = studios[0].id;
            pushFeed("info", "🎯", `Studio: ${studios[0].name || studios[0].id} (auto-injected into tool args)`);
          }
        }catch{}
      }
    }catch{}
    if(myGen !== A.startGen) return;
    try{ P.setInputLock && P.setInputLock(true); }catch{}
    await sendSystemPromptAndStarter();
    try{ P.setInputLock && P.setInputLock(false); }catch{}
    updateWorkspaceView();
  }

  function stopSession(){
    if(!A.started) return;
    A.stopping = true; A.running = false; A.busy = false; A.injecting = false;
    A.startGen++;
    if(execMgr) try{ execMgr.cancelAll("user stop"); }catch{}
    if(fsm) try{ fsm.transition("STOPPED", "user"); }catch{}
    if(P.stopGeneration) try{ P.stopGeneration(); }catch{}
    setLauncherStopped();
    pushFeed("info", "⏹", "Agent stopped by user");
    showBanner("Agent stopped. Click Start to run again.", "warn", 4000);
  }
  function setLauncherStopped(){
    launcher.classList.remove("is-active", "is-starting");
    launcher.innerHTML = `<span class="rl-logo">R</span><span class="rl-label">Start RoLink agent</span>`;
    document.getElementById("rl-stop-btn").style.display = "none";
  }
  function setLauncherRunning(){
    launcher.classList.remove("is-starting");
    launcher.classList.add("is-active");
    launcher.innerHTML = `<span class="rl-stop-dot"></span><span class="rl-label">Stop agent</span>`;
  }

  launcher.addEventListener("click", ()=>{ if(A.started) stopSession(); else startSession(); });
  document.getElementById("rl-stop-btn").addEventListener("click", ()=>stopSession());

  // ── LIVE tool-block stripping + whole-item text scan ────────────────────
  // Reliability: live stripping only HIDES blocks and marks dispatched; actual execution
  // is owned by the agentLoop sequential await path. These sweeps are camouflage, not executors.
  // To avoid concurrent chaos, they NO LONGER dispatch directly — they hide and let agentLoop pick up.
  // However legacy onUserMessage re-arm still needs immediate dispatch when loop is idle — handled there.
  function scanToolBlocks(node){
    if(!node || node.nodeType !== 1) return;
    const candidates = [];
    if(node.tagName === "PRE" || node.tagName === "CODE") candidates.push(node);
    if(node.querySelectorAll) candidates.push(...node.querySelectorAll("pre, code"));
    for(const el of candidates){
      if(!el || A.strippedBlocks.has(el)) continue;
      const txt = el.innerText || el.textContent || "";
      if(!txt || txt.indexOf("###MCP_TOOL###") === -1) continue;
      if(ZSParse.hasOpenToolBlock(txt)) continue;
      const calls = ZSParse.extractAll(txt).filter(Boolean);
      if(!calls.length) continue;
      A.strippedBlocks.add(el);
      if(el.parentElement) el.parentElement.style.display = "none";
      // No direct dispatch here — agentLoop's waitForReply will detect and await execution
    }
  }
  // Whole-item text scan (ZeroScript decorate.sweep pattern). Critical for
  // sites that split a tool block across multiple <p>/<div> elements.
  // Now: only camouflage (hide), execution is awaited in agentLoop.
  function wholeItemScan(){
    if(!P || !P.allItems) return;
    try{
      const items = P.allItems();
      for(const it of items){
        if(!it) continue;
        const text = joinItemText(it);
        if(!text || text.indexOf("###MCP_TOOL###") === -1) continue;
        if(ZSParse.hasOpenToolBlock(text)) continue;
        if(it.querySelector(".rl-chip")) continue;
        const calls = ZSParse.extractAll(text).filter(Boolean);
        if(!calls.length) continue;
        // Hide camouflage only; mark dispatched to avoid re-hiding spam
        if(A.dispatchedItems && A.dispatchedItems.has(it)) continue;
        A.dispatchedItems = A.dispatchedItems || new WeakSet();
        A.dispatchedItems.add(it);
        it.querySelectorAll("pre, code, p, div").forEach(el => {
          if(A.strippedBlocks.has(el)) return;
          const t = (el.innerText || el.textContent || "");
          if(t.indexOf("###MCP_TOOL###") !== -1 || ZSParse.hasOpenToolBlock(t)){
            A.strippedBlocks.add(el);
            el.style.display = "none";
          }
        });
      }
    }catch{}
  }
  function joinItemText(item){
    if(!item) return "";
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if(!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        let p = n.parentElement;
        while(p && p !== item){
          if(p.id && (p.id === "rl-root" || p.id === "rl-bar" || p.id === "rl-tools" ||
                      p.id === "rl-feed" || p.id === "rl-workspace" || p.id === "rl-banner" ||
                      p.id === "rl-input-cover")) return NodeFilter.FILTER_REJECT;
          if(p.classList && p.classList.contains("rl-chip")) return NodeFilter.FILTER_REJECT;
          if(p.style && p.style.display === "none") return NodeFilter.FILTER_REJECT;
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const parts = [];
    let n;
    while((n = walker.nextNode())) parts.push(n.nodeValue);
    return parts.join(" ");
  }

  // ── CAMOUFLAGE: hide raw tool blocks + injected feedback turns ──────────
  const S_CHAT_ITEM = "[data-message-author-role], .ds-message, [data-testid*='conversation-turn'], article, .message, main p";
  const INJECTED_RE = /^\s*\[(Tool result for|Tool error for) /;
  const DONT_ASK_RE = /Don't ask\. ACT\./i;
  function isInjectedText(txt){
    if(!txt) return false;
    if(INJECTED_RE.test(txt)) return true;
    if(DONT_ASK_RE.test(txt)) return true;
    if(txt.indexOf(SYS_MARKER_TEXT) !== -1) return true;
    return false;
  }
  function camouflageSweep(){
    if(!P || !P.allItems) return;
    const items = P.allItems();
    for(const it of items){
      if(it.classList.contains("rl-hidden")) continue;
      const txt = joinItemText(it);
      if(!txt) continue;
      if(isInjectedText(txt)){
        it.classList.add("rl-hidden");
      }
    }
  }
  // preHideWholeItems: synchronous pre-hide of freshly injected result turns.
  // Called right after submitAndGetBase returns, with a 2.5s window during
  // which the NEWEST user turn is treated as ours and pre-masked on sight.
  function preHideWholeItems(){
    if(!P || !P.allItems) return;
    if(A.injectHideUntil && Date.now() < A.injectHideUntil){
      const items = P.allItems();
      const users = items.filter(it => P.isUserItem && P.isUserItem(it));
      const last = users[users.length - 1];
      if(last && !last.classList.contains("rl-hidden") && users.length > (A.injectPreUser || 0)){
        last.classList.add("rl-hidden");
        A.injectHideUntil = 0;
        diag("result.prehide", { users: users.length });
      }
    }
  }

  // inputCover: transparent overlay during every inject
  let _inputCoverEl = null;
  function inputCover(on){
    if(on){
      if(_inputCoverEl) return;
      const ed = P.getEditor ? P.getEditor() : null;
      if(!ed) return;
      const frame = ed.closest("form, .ds-message-edit, [class*='composer' i], [class*='editor' i], [class*='input' i]") || ed.parentElement;
      if(!frame) return;
      const rect = frame.getBoundingClientRect();
      _inputCoverEl = document.createElement("div");
      _inputCoverEl.id = "rl-input-cover";
      Object.assign(_inputCoverEl.style, {
        position: "fixed",
        left: rect.left + "px",
        top: rect.top + "px",
        width: rect.width + "px",
        height: rect.height + "px",
        zIndex: "2147483500",
        background: "rgba(47,129,247,0.06)",
        backdropFilter: "blur(2px)",
        cursor: "not-allowed",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "rgba(255,255,255,0.7)",
        font: "600 12px system-ui",
        borderRadius: "8px",
        pointerEvents: "auto",
      });
      _inputCoverEl.innerHTML = `<span>🔄 Agent working…</span>`;
      document.body.appendChild(_inputCoverEl);
    } else {
      if(_inputCoverEl){ _inputCoverEl.remove(); _inputCoverEl = null; }
    }
  }

  function startObserver(){
    if(A.observeTarget) return;
    A.observeTarget = document.documentElement;
    const obs = new MutationObserver(muts=>{
      for(const m of muts) for(const n of m.addedNodes) scanToolBlocks(n);
      camouflageSweep();
    });
    try{ obs.observe(document.documentElement, {childList:true, subtree:true, characterData:true}); }catch{}
    setInterval(camouflageSweep, 1500);
    setInterval(wholeItemScan, 1500);
    setInterval(()=>{
      try{
        const items = (P && P.allItems) ? P.allItems() : [];
        for(const it of items){
          if(!it || A.strippedBlocks.has(it)) continue;
          if(it.querySelectorAll) scanToolBlocks(it);
        }
      }catch{}
    }, 2000);
  }

  // ── syncSessionState: track which conversation the loop is bound to ─────
  let lastSyncPath = null;
  function syncSessionState(){
    if(A.starting){
      const key = P.conversationKey();
      if(A.startingKey == null){
        if(key && P.chatIsEmpty && !P.chatIsEmpty()) A.startingKey = key;
      } else if(key !== A.startingKey && P.chatIsEmpty && P.chatIsEmpty()){
        A.startGen++;
        A.starting = false;
        A.startingKey = null;
        try{ P.setInputLock && P.setInputLock(false); }catch{}
        setLauncherStopped();
        try{ inputCover(false); }catch{}
      }
    }
    if(A.running){
      const key = P.conversationKey();
      if(A.loopKey == null){
        if(key && P.chatIsEmpty && !P.chatIsEmpty()) A.loopKey = key;
      } else if(key !== A.loopKey && P.chatIsEmpty && P.chatIsEmpty()){
        diag("loop.abandonedNewChat", { from: A.loopKey, to: key });
        A.stopping = true; A.loopKey = null;
      }
    }
  }
  // Run syncSessionState periodically + on visibility change
  setInterval(syncSessionState, 1500);
  document.addEventListener("visibilitychange", ()=>{ if(!document.hidden) syncSessionState(); });

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

  startObserver();
  wireUi();

  // ── installSendHooks: wire user-send interception ─────────────────────────
  if(P.installSendHooks){
    P.installSendHooks({
      isBlocked: () => A.injecting || A.running || A.starting,
      isStarted: () => A.started || A.sessionEverStarted === true,
      onBlockedAttempt: () => {
        showBanner("Click Start to begin a RoLink session, or wait for the current one to finish.", "warn", 4000);
      },
      onUserMessage: (base) => {
        pushFeed("info", "💬", "User sent a message — re-arming agent loop");
        A.userStopped = false;
        A.lastAssistantIdAtBoot = P.lastAssistantId ? P.lastAssistantId() : null;
        captureSendToken();
        bumpSys("users");
        if(sysResendDue()){
          pushFeed("info", "🔁", "Re-anchoring system prompt (long session)");
          resetSysCount();
        }
        // Phase 5d: session-drift detection. After DRIFT_TURNS turns without
        // a successful tool call, re-inject the format reminder so the model
        // doesn't burn a turn producing bad output. (the count is per-provider
        // so Gemini's drift doesn't reset DeepSeek's, etc.)
        try{
          if(typeof window !== "undefined" && window.__rolinkDrift && window.__rolinkDrift.shouldReinject && window.__rolinkDrift.shouldReinject(P.id || "generic")){
            pushFeed("info", "🧭", `Drift detected on ${P.id||"provider"} — re-anchoring tool format`);
            if(window.__rolinkDrift.noteReinject) window.__rolinkDrift.noteReinject(P.id || "generic");
            // Bumping sys count forces sysResendDue() on the next tool result.
            bumpSys("drift");
          }
          if(window.__rolinkDrift && window.__rolinkDrift.noteTurn) window.__rolinkDrift.noteTurn(P.id || "generic");
        }catch{}
        A.started = true; A.sessionEverStarted = true;
        // SAFETY NET: camouflage sweep only — agentLoop will pick up tools sequentially.
        // Previously this dispatched via setTimeout concurrent chaos; now just hide.
        try{
          const items = (P && P.allItems) ? P.allItems() : [];
          for(const it of items){
            if(!it) continue;
            const text = joinItemText(it);
            if(!text || text.indexOf("###MCP_TOOL###") === -1) continue;
            if(ZSParse.hasOpenToolBlock(text)) continue;
            const calls = ZSParse.extractAll(text).filter(Boolean);
            if(!calls.length) continue;
            if(it.querySelector(".rl-chip")) continue;
            it.querySelectorAll("pre, code, p, div").forEach(el => {
              if(A.strippedBlocks.has(el)) return;
              const t = (el.innerText || el.textContent || "");
              if(t.indexOf("###MCP_TOOL###") !== -1 || ZSParse.hasOpenToolBlock(t)){
                A.strippedBlocks.add(el);
                el.style.display = "none";
              }
            });
          }
        }catch{}
        setTimeout(() => {
          if(A.stopping || A.userStopped) return;
          if(!A.running && !A.injecting){
            A.feedStreak = 0; A.nudgesLeft = 1; A.toolCount = 0;
            A.strippedBlocks = new WeakSet();
            A.dispatchedItems = new WeakSet();
            A.loopKey = P.conversationKey ? P.conversationKey() : location.pathname;
            A.running = true;
            document.getElementById("rl-stop-btn").style.display = "inline-flex";
            launcher.classList.add("is-active");
            launcher.innerHTML = `<span class="rl-stop-dot"></span><span class="rl-label">Stop agent</span>`;
            agentLoop(typeof base === "number" ? base : (P.assistantCount ? P.assistantCount() : 0));
          }
        }, 300);
      },
      onNativeStop: () => {
        A.userStopped = true;
        A.turnedStopped = true;
        A.stoppedAt = Date.now();
        if(A.running){ A.stopping = true; A.running = false; }
        try{ P.stopGeneration && P.stopGeneration(); }catch{}
        pushFeed("info", "⏸", "Native Stop clicked — agent paused");
      },
      onNativeContinue: () => {
        A.userStopped = false;
        A.turnedStopped = false;
        pushFeed("info", "▶", "Native Continue clicked — agent resumed");
      },
    });
  }

  // expose for debug / popup
  window.ROLINK = {
    start: startSession,
    stop: stopSession,
    status: ()=>A,
    tools: ()=>A.tools,
    diag: ()=>A.diag,
    P,
  };
})();
