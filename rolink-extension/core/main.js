// SPDX-License-Identifier: GPL-3.0-or-later
// core/main.js - RoLink v2.0 agentic loop + UI (the brain).
//
// Architecture (ZeroScript-style ZSProvider, RoLink-branded + extended):
//   - providers/*.js exports a global ZSProvider object with the site-specific
//     bits: selectors, generation detection, send mechanics, image attach.
//   - core/parser.js exposes ZSParse (pure string parser) for tool blocks.
//   - This file owns the agent loop, UI, session state. It NEVER touches the
//     host site's DOM directly - everything goes through ZSProvider.
//   - All tool calls route through background.js (which owns the single bridge
//     WebSocket). The AI tab never opens its own WS.
//
// Loop (FSM, mirror of ZeroScript's proven design + RoLink extensions):
//   1. startSession(): drive the composer into agent-ready state (e.g. Expert
//      on DeepSeek), inject a real system prompt + the user's starter, send.
//   2. agentLoop(): wait for the AI's reply, classify it (tool / text / empty /
//      truncated / too-long). On tool: dispatch via bg(), replace the raw
//      block with a chip, feed the result back. On text: classify intent
//      (real answer vs "what should I build?" / "I can't run commands") and
//      react appropriately.
//   3. Live tool-block stripping: as soon as `###MCP_TOOL###` appears in the
//      DOM (mid-stream), hide it and show a chip. User never sees raw JSON.
//   4. Auto-resume watchdog: if a tool's result is dropped on the floor (AI
//      went silent), re-feed the same payload. Bounded retries, no infinite loop.
//   5. Tab-visibility gate: pause while the AI tab is hidden (background tabs
//      throttle rendering), resume when foregrounded.
//   6. Image attach: if a tool returns images, upload them to the AI tab so
//      the model can actually SEE the result.
//   7. Session memory: persist the system prompt, conversation history, and
//      notes per conversation in chrome.storage so future sessions can
//      inherit them.
//   8. Native-tool lockdown: explicitly tell the AI to ONLY use the RoLink
//      commands, never its own built-in tools.

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
    maxFeedStreak: 14,         // give up after this many in a row
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
    sessionId: null,           // per-conversation session id (for memory)
    customPrompt: "",          // user-added prompt from the panel
    history: [],               // {role, text, ts} entries for this session
    nudgeCount: 0,             // how many nudges we've sent in this session
    maxNudges: 4,              // give up after this many nudges
    strippedBlocks: new WeakSet(), // already-hidden tool blocks (so we don't re-hide)
  };

  // ── DOM helpers ──────────────────────────────────────────────────────────
  function el(tag, cls, html){ const e=document.createElement(tag); if(cls) e.className=cls; if(html!=null) e.innerHTML=html; return e; }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);}
  function shorten(s, n){ s=String(s); return s.length>n ? s.slice(0, n-1) + "…" : s; }

  // ── session memory (chrome.storage) ──────────────────────────────────────
  // Per-conversation: {systemPrompt, history:[], notes:""}
  // Keys: rolSession_<sessionId>
  function sessionKey(){ return "rolSession_" + (A.sessionId || (location.pathname + "|" + location.hostname)); }
  function sessionIdFromUrl(){
    try{
      // Use pathname + a stable hash of the first user message if we can find one
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
        history: A.history.slice(-200), // cap
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
    <button class="rl-btn" id="rl-workspace-btn" title="Workspace memory">🧠</button>
    <button class="rl-btn" id="rl-settings-btn" title="Settings">⚙</button>
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
        <textarea id="rl-custom-prompt" placeholder="e.g. Always use the FastFlag &quot;FFlagDebugSimulatorBetaFeatures&quot; before reading the tree. Prefer using tween-based movement."></textarea>
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
    document.getElementById("rl-tools-btn").onclick = e => { e.stopPropagation(); closeWorkspace(); toolsPanel.classList.toggle("rl-show"); };
    document.getElementById("rl-feed-btn").onclick = e => { e.stopPropagation(); closeWorkspace(); toolsPanel.classList.remove("rl-show"); feed.classList.toggle("rl-show"); };
    document.getElementById("rl-feed-clear").onclick = e => { e.stopPropagation(); document.getElementById("rl-feed-list").innerHTML=""; };
    document.getElementById("rl-workspace-btn").onclick = e => {
      e.stopPropagation();
      toolsPanel.classList.remove("rl-show"); feed.classList.remove("rl-show");
      wsPanel.classList.toggle("rl-show");
      if(wsPanel.classList.contains("rl-show")) updateWorkspaceView();
    };
    document.getElementById("rl-settings-btn").onclick = e => {
      e.stopPropagation();
      document.getElementById("rl-workspace-btn").click();
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
    // click outside to close
    document.addEventListener("click", e => {
      if(!wsPanel.contains(e.target) && e.target.id !== "rl-workspace-btn" && e.target.id !== "rl-settings-btn"){
        closeWorkspace();
      }
    }, true);
  }
  function closeWorkspace(){ wsPanel.classList.remove("rl-show"); }
  function updateWorkspaceView(){
    document.getElementById("rl-session-id").textContent = A.sessionId || "default";
    document.getElementById("rl-history-count").textContent = A.history.length + " event" + (A.history.length === 1 ? "" : "s");
    document.getElementById("rl-custom-prompt").value = A.customPrompt || "";
  }

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
  // Built dynamically. The model is a Roblox Studio agent. We are SHORT and
  // DEMANDING. Two patterns: tool call or DONE. No prose padding.
  function buildSystemPrompt(){
    const tools = Array.isArray(A.tools) && A.tools.length ? A.tools : null;
    let toolBlock;
    if(tools){
      const names = tools.map(t => (typeof t === "string") ? t : (t && t.name) || "").filter(Boolean);
      toolBlock = "Tools you can call (use the EXACT name; one ###MCP_TOOL### block per call; you can call multiple per reply):\n"
                + names.map(n => "- " + n).join("\n")
                + (names.length ? "\n\nArgument schema is whatever the bridge accepts. If a call fails, read the error and fix it on the next call — don't guess at unrelated tool names." : "");
    } else {
      toolBlock = "Tools will be discovered at session start. Begin by trying common RoLink tools like `get_studio_state`, `list_roblox_studios`, `get_snapshot`, `run_code`.";
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

- ACT FIRST. Never ask the user "what should I build?" — if no task is given, PICK one (e.g. "I'll make a simple obby with checkpoints") and start building it. The user will redirect you if they want something different.
- NEVER say "I cannot run commands" or "I don't have access to your files". Your tools ARE working. Just emit the right ###MCP_TOOL### block.
- ONLY use the tools listed above. Do NOT use any built-in code interpreter, web search, file browser, or other native tool — even if the site offers them. The Roblox MCP tools are the only thing you should call.
- If a tool call fails, read the error message, fix the call (correct args, valid JSON, valid Luau), and retry. Don't apologize and stop.
- Keep prose short. The user wants to see tool calls and results, not essays.
- When fully done: one-sentence summary + DONE.`;
  }

  const STARTER = `Begin now. First call: get_studio_state to confirm the place is open, then list_roblox_studios to see what's connected, then start a reasonable starter project (e.g. a simple obby with a spawn, a few platforms, and a killbrick). ACT, don't ask.`;

  // ── dispatch a tool call ──────────────────────────────────────────────────
  function dispatchTool(name, args, sourceBlock, sourceItem, images){
    if(sourceBlock && sourceBlock.parentElement && !A.strippedBlocks.has(sourceBlock)){
      A.strippedBlocks.add(sourceBlock);
      // Hide the raw tool block (and its code-fence wrapper) before chip insertion
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
    const spot = P.findToolBlockSpot ? P.findToolBlockSpot(sourceItem, chip) : null;
    if(spot && spot.parent){
      spot.parent.insertBefore(chip, spot.ref || null);
    } else if(sourceBlock && sourceBlock.parentElement && sourceBlock.parentElement.parentElement){
      sourceBlock.parentElement.parentElement.insertBefore(chip, sourceBlock.parentElement);
    } else {
      (sourceBlock || document.body).appendChild(chip);
    }
    A.busy = true; A.toolRunning = name; A.toolStart = Date.now();
    pushFeed("tool", "⚙", `${name} ${JSON.stringify(args).slice(0,180)}`);
    setCounter(++A.toolCount);
    A.history.push({role:"tool_call", name, args, ts:Date.now()});
    saveSession();
    return new Promise(resolve=>{
      bg({type:"call_tool", name, arguments: args, timeout: 120000}).then(res=>{
        A.busy = false; A.toolRunning = "";
        if(!res) res = {ok:false, error:"no response from bridge"};
        if(res.kind === "stale-extension" || isContextInvalidated(res.error)){
          chipFinalize(chip, name, {ok:false, error:"Extension updated — please reload this page and click Start again."});
          pushFeed("err", "✗", "Extension context invalidated. Reload the page.");
          A.running = false; setLauncherStopped();
          resolve({chip, name, res});
          return;
        }
        chipFinalize(chip, name, res);
        const text = res.ok ? (res.text || "OK") : ("ERROR: " + (res.error || "unknown"));
        const ok = res.ok !== false;
        pushFeed(ok ? "ok" : "err", ok ? "✓" : "✗", `${name}: ${shorten(String(text).replace(/\n/g," "), 200)}`);
        A.history.push({role:"tool_result", name, ok, text, ts:Date.now()});
        saveSession();
        // If the tool returned images, attach them to the next feedback.
        const imgs = (res && res.images && res.images.length) ? res.images : null;
        A.lastFeedText = text; A.lastFeedAt = Date.now(); A.lastFeedId = name + ":" + Date.now();
        // Truncate huge results so we don't blow context
        const textForModel = text.length > 12000 ? text.slice(0, 11500) + "\n\n[…result truncated for context; full result is in the chip above…]" : text;
        const hint = (!ok && /unknown tool/i.test(text) && Array.isArray(A.tools) && A.tools.length)
          ? `\n\nThe valid tool names right now are: ${A.tools.map(t => (typeof t==="string")?t:(t&&t.name)||"").filter(Boolean).join(", ")}.`
          : "";
        const feedbackMsg = ok
          ? `[Tool result for ${name}]\n${textForModel}\n\nYou MUST continue. Either call another tool via ###MCP_TOOL### {json} OR give a final answer ending with DONE. Do NOT respond with "I cannot run commands" — your tools are working.`
          : `[Tool error for ${name}]\n${text}\n\nThe tool call failed. Fix the call (correct args, valid JSON, valid Luau) and retry with another ###MCP_TOOL### block using the EXACT name from the system prompt.${hint}`;
        A.injecting = true;
        P.typeAndSend(feedbackMsg, imgs || []).then(()=>{ A.injecting = false; });
        resolve({chip, name, res, text});
      });
    });
  }

  // ── detect "AI is asking the user a question" ──────────────────────────────
  // Used to auto-nudge the model when it just asks "what should I build?"
  // instead of doing something.
  function looksLikeAQuestion(text){
    if(!text) return false;
    const t = text.trim();
    if(!t) return false;
    // Very short replies that end with a question → ask, not act
    if(t.length < 400 && /\?[\s]*$/.test(t) && !/###MCP_TOOL###/.test(t) && !/###LUA###/.test(t)) return true;
    // Common "asking" patterns
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
    A.history.push({role:"user", text: first, ts:Date.now()});
    saveSession();
    return P.typeAndSend(first, []).then(()=>{
      A.starting = false;
      A.loopKey = P.conversationKey ? P.conversationKey() : location.pathname;
      A.running = true;
      A.feedStreak = 0;
      A.nudgeCount = 0;
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
      const done = () => { document.removeEventListener("visibilitychange", onVis); clearInterval(iv); A.parked = false; if(!A.stopping) pushFeed("info", "▶", "Resumed"); resolve(!A.stopping); };
      const onVis = () => { if(!document.hidden) done(); };
      document.addEventListener("visibilitychange", onVis);
      const iv = setInterval(()=>{ if(A.stopping || !document.hidden) done(); }, 500);
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
          A.nudgeCount = 0;
          for(let i = 0; i < reply.calls.length; i++){
            const c = reply.calls[i];
            setTimeout(()=>dispatchTool(c.name, c.arguments, null, reply.item), i*30);
          }
        } else if(reply.kind === "text"){
          // FIRST: detect "AI is asking a question" → nudge it to ACT.
          if(looksLikeAQuestion(reply.text) && A.nudgeCount < A.maxNudges){
            A.nudgeCount++;
            pushFeed("warn", "↻", `AI asked a question (${A.nudgeCount}/${A.maxNudges}) — nudging to ACT`);
            A.injecting = true;
            await P.typeAndSend(`Don't ask. ACT. Pick the simplest reasonable interpretation of the user's intent and start building it right now. If a tool fails, fix it. If you need to make up defaults, do it. Emit a ###MCP_TOOL### block in your very next reply.`, []);
            A.injecting = false;
            continue;
          }
          // SECOND: detect "I cannot run commands" → stronger re-grounding.
          if(looksLikeCantRun(reply.text) && A.nudgeCount < A.maxNudges){
            A.nudgeCount++;
            pushFeed("warn", "↻", `AI claimed it can't run tools (${A.nudgeCount}/${A.maxNudges}) — re-grounding`);
            A.injecting = true;
            await P.typeAndSend(`You DO have tools. They are listed in your system prompt and have been used successfully in this session. Re-read your system prompt. The valid tool names are: ${(A.tools||[]).map(t=>(typeof t==="string")?t:(t&&t.name)||"").filter(Boolean).join(", ")}. Emit a ###MCP_TOOL### block now using one of these exact names.`, []);
            A.injecting = false;
            continue;
          }
          // Real answer → done.
          pushFeed("done", "🏁", `Agent finished (${A.toolCount} tool call${A.toolCount === 1 ? "" : "s"}).`);
          A.running = false; A.started = false;
          setLauncherStopped();
          showBanner("Agent finished. Click Start to run again.", "ok", 5000);
          return;
        } else if(reply.kind === "truncated"){
          if(P.clickContinueBtn && P.clickContinueBtn()){ pushFeed("info", "↻", "Clicked Continue (truncated reply)"); continue; }
          A.injecting = true;
          await P.typeAndSend("Your last reply was truncated. Please redo the tool call (or final answer) in full. Do not include ###END markers or closing fences you don't need.", []);
          A.injecting = false;
        } else if(reply.kind === "empty"){
          A.feedStreak++;
          if(A.feedStreak > A.maxFeedStreak){
            pushFeed("err", "⏹", `Gave up after ${A.maxFeedStreak} empty replies. Click Start to try again.`);
            A.running = false; A.started = false; setLauncherStopped(); return;
          }
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
          await P.typeAndSend(`Your last tool call was malformed JSON (${reply.reason}).

To pass a code string to execute_luau, you MUST escape every double quote in the code with a backslash, and put the whole code on one logical line with \\n for newlines. For example:

###MCP_TOOL###
{"tool":"execute_luau","args":{"code":"local p = Instance.new(\\"Part\\"); p.Parent = game.Workspace; print(\\"hi\\")"}}

Alternatively use the ###LUA### ... ###END_LUA### form (no escaping needed):

###LUA###
local p = Instance.new("Part")
p.Parent = game.Workspace
print("hi")
###END_LUA###

Retry now with valid JSON (or use the ###LUA### form).`, []);
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
        lastActive += 500;
      }
      const gen = P.isGenerating();
      if(gen) lastActive = Date.now();
      const newId = P.lastAssistantId ? P.lastAssistantId() : null;
      const newTurn = lastSeenAssistantId == null
        ? (P.assistantCount() > 0)
        : (newId != null && newId !== lastSeenAssistantId);
      const d = P.readAssistant();
      const replyText = (d && d.reply) || "";
      const replyNorm = replyText.replace(/\s+/g," ").trim();
      if(replyNorm !== lastText){ lastText = replyNorm; lastChange = Date.now(); lastActive = Date.now(); }
      if(!started){
        if(newTurn && (replyText.length || gen)) started = true;
        else {
          if(!warmSince) warmSince = Date.now();
          if(Date.now() - warmSince > 60000) return {kind:"empty"};
          await sleep(200); continue;
        }
      }
      // Wait for: not generating AND text stable for STABLE_MS AND no open tool block
      if(!gen && Date.now() - lastChange > STABLE_MS && !ZSParse.hasOpenToolBlock(replyText)){
        const tools = ZSParse.extractAll(replyText);
        if(tools && tools.length){
          const calls = tools.map(ZSParse.normalize).filter(Boolean);
          if(calls.length){
            const lastId = newId;
            return {kind:"tool", calls, item: d.item, lastId};
          }
        }
        if(P.findContinueBtn && P.findContinueBtn()) return {kind:"truncated", text: replyText, item: d.item};
        if(P.isTooLongMsg && P.isTooLongMsg(replyText)) return {kind:"too_long", text: replyText};
        const ctx = P.scanError && P.scanError();
        if(ctx) return {kind:"context_limit", detail: ctx};
        if(ZSParse.hasToolSignature(replyText)){
          return {kind:"parse_error", reason:"malformed", raw: replyText, item: d.item};
        }
        if(!replyText.trim()) return {kind:"empty"};
        return {kind:"text", text: replyText, item: d.item};
      } else {
        lastChange = Date.now();
        await sleep(160); continue;
      }
    }
    return {kind:"timeout"};
  }

  // ── launcher click: start a session ──────────────────────────────────────
  async function startSession(){
    if(A.started) return;
    A.started = true; A.starting = true; A.running = false; A.stopping = false;
    A.feedStreak = 0; A.toolCount = 0; A.lastFeedText = ""; A.lastFeedAt = 0; A.lastFeedId = null;
    A.nudgeCount = 0;
    A.strippedBlocks = new WeakSet();
    setCounter(0);
    document.getElementById("rl-feed-list").innerHTML = "";
    launcher.classList.add("is-active");
    launcher.innerHTML = `<span class="rl-stop-dot"></span><span class="rl-label">Stop agent</span>`;
    document.getElementById("rl-stop-btn").style.display = "inline-flex";
    pushFeed("info", "▶", `Agent starting on ${location.hostname}`);
    showBanner("Agent starting…", "ok", 3000);
    placeBar();
    if(P.ensureComposerReady){
      try{
        const s = await P.ensureComposerReady("startup");
        if(!s.ready){
          pushFeed("err", "⏹", "Composer not ready (no model selected). Pick Expert/Instant/Vision and try again.");
          A.started = false; A.starting = false; setLauncherStopped(); return;
        }
      }catch{}
    }
    A.sessionId = sessionIdFromUrl();
    await loadSession();
    A.customPrompt = await loadCustomPrompt();
    A.startingKey = P.conversationKey ? P.conversationKey() : location.pathname;
    A.lastAssistantIdAtBoot = P.lastAssistantId ? P.lastAssistantId() : null;
    try{ await refreshTools(); }catch{}
    try{ P.setInputLock && P.setInputLock(true); }catch{}
    sendSystemPromptAndStarter();
    try{ P.setInputLock && P.setInputLock(false); }catch{}
    updateWorkspaceView();
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

  // ── LIVE tool-block stripping (mid-stream, as soon as a marker appears) ───
  // Scans the DOM for new <pre>/<code> elements containing ###MCP_TOOL### or
  // ###LUA### markers. Hides the raw block and dispatches the tool immediately
  // (so the chip appears the moment the AI starts writing the tool call, not
  // only after the whole turn finishes).
  function scanToolBlocks(node){
    if(!node || node.nodeType !== 1) return;
    if(A.busy) return; // don't race the active dispatch
    const candidates = [];
    if(node.tagName === "PRE" || node.tagName === "CODE") candidates.push(node);
    if(node.querySelectorAll) candidates.push(...node.querySelectorAll("pre, code"));
    for(const el of candidates){
      if(!el || A.strippedBlocks.has(el)) continue;
      const txt = el.innerText || el.textContent || "";
      if(!txt || txt.indexOf("###MCP_TOOL###") === -1) continue;
      if(ZSParse.hasOpenToolBlock(txt)) continue; // wait for it to finish
      // Extract ALL tool blocks in this <pre> (models often emit multiple per reply)
      const blks = ZSParse.extractAll(txt);
      const calls = blks.map(ZSParse.normalize).filter(Boolean);
      if(!calls.length) continue;
      A.strippedBlocks.add(el);
      const item = el.closest(S_CHAT_ITEM) || el.closest("[data-message-author-role]") || el.closest(".ds-message") || el.closest("article") || el.closest("main") || null;
      // Hide the whole <pre> at once (so the user never sees ANY of the raw JSON)
      if(el.parentElement) el.parentElement.style.display = "none";
      // Dispatch each call sequentially (preserves argument order, avoids races)
      for(let i = 0; i < calls.length; i++){
        setTimeout(()=>dispatchTool(calls[i].name, calls[i].arguments, el, item), i*30);
      }
    }
  }
  const S_CHAT_ITEM = "[data-message-author-role], .ds-message, [data-testid*='conversation-turn'], article, .message, main p";
  function startObserver(){
    if(A.observeTarget) return;
    A.observeTarget = document.documentElement;
    const obs = new MutationObserver(muts=>{
      for(const m of muts) for(const n of m.addedNodes) scanToolBlocks(n);
    });
    try{ obs.observe(document.documentElement, {childList:true, subtree:true, characterData:true}); }catch{}
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
  wireUi();

  // expose for debug / popup
  window.ROLINK = {
    start: startSession,
    stop: stopSession,
    status: ()=>A,
    tools: ()=>A.tools,
    P,
  };
})();
