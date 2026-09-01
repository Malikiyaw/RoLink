// SPDX-License-Identifier: GPL-3.0-or-later
// core/main.js - RoLink in-page agentic loop + UI.
//
// This is the brain. It does the full Lemonade/ZeroDev-style loop:
//   1. Click "Start agent" -> injects a real, working system prompt + a
//      starter task into the AI's input box and auto-sends it.
//   2. Watches the AI's replies for ###MCP_TOOL### {json} blocks. Dispatches
//      each tool via background.js, replaces the raw block with a tool chip
//      (icon + tool name + args + result), feeds the result back to the AI.
//   3. If the AI replies with plain text (no tool block) the agent does NOT
//      sit there - it sends a "use ###MCP_TOOL###" nudge so the AI keeps
//      acting until it explicitly answers the user.
//   4. Stops when the AI's last reply is plain text AND it contains no
//      tool-block markers (the AI is done acting).
//
// Everything routed through background.js (single bridge WS). UI lives in
// a #rl-root container so host-site CSS can't break it.

(function(){
  "use strict";
  if(window.__rolink_injected) return; window.__rolink_injected=true;

  // ── chrome.runtime.sendMessage wrapper ────────────────────────────────────
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
        if(/Extension context invalidated|message port closed|message port closed/i.test(String(e))){
          bgAvailable = false;
        }
        resolve({ok:false, error:String(e)});
      }
    });
  }

  // ── state ────────────────────────────────────────────────────────────────
  const S = {
    started: false,
    running: false,             // loop is actively driving the AI
    injecting: false,
    busy: false,
    lastText: "",               // last plain-text reply we saw (for stop detection)
    lastTextTs: 0,
    lastFeedTs: 0,
    consecutiveNudges: 0,       // how many "use tool" nudges we've sent in a row
    maxNudges: 6,               // give up after this many nudges with no tool (avoid infinite loop)
    finished: false,
    toolCount: 0,
    observeTarget: null,
  };

  // ── DOM helpers ──────────────────────────────────────────────────────────
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);}
  function el(tag, cls, html){ const e=document.createElement(tag); if(cls) e.className=cls; if(html!=null) e.innerHTML=html; return e; }

  // ── find chat input / send button (works on every provider) ──────────────
  function pickInput(){
    const sels = [
      "textarea:not([readonly]):not([disabled])",
      "[contenteditable='true']",
      "[role='textbox']",
      "div[data-testid='chat-input']",
      "textarea[data-testid='chat-input']",
      "textarea[placeholder*='Message' i]",
      "textarea[placeholder*='Ask' i]",
      "textarea[placeholder*='Send' i]",
      "textarea[placeholder*='Type' i]",
      "textarea[placeholder*='Ask anything' i]",
      "textarea[placeholder*='Chat' i]",
      "div[aria-label*='message' i][contenteditable='true']",
    ];
    for(const s of sels){
      const els = document.querySelectorAll(s);
      for(const e of els){ if(e.offsetParent !== null && !e.disabled) return e; }
    }
    return null;
  }
  function pickSendBtn(){
    const sels = [
      "button[data-testid='send-button']",
      "button[aria-label*='Send' i]",
      "button[aria-label*='Submit' i]",
      "form button[type='submit']",
      "button[title*='Send' i]",
    ];
    for(const s of sels){
      const els = document.querySelectorAll(s);
      for(const e of els){ if(e.offsetParent !== null && !e.disabled) return e; }
    }
    return null;
  }
  function setReactValue(el,val){
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLDivElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto,"value")?.set;
    if(setter){ setter.call(el,val); el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true})); }
    else { el.value = val; el.dispatchEvent(new Event("input",{bubbles:true})); }
  }
  function setCE(el,val){
    el.focus();
    try{ document.execCommand("selectAll",false,null); document.execCommand("insertText",false,val); return; }catch{}
    el.innerText = val;
    el.dispatchEvent(new InputEvent("input",{bubbles:true,data:val,inputType:"insertText"}));
  }
  function clearEditor(el){
    if(el.tagName === "TEXTAREA") setReactValue(el, "");
    else setCE(el, "");
  }
  function typeAndSend(text, imageData){
    return new Promise(resolve=>{
      const el = pickInput();
      if(!el){ resolve(false); return; }
      el.focus();
      if(el.tagName === "TEXTAREA") setReactValue(el, text); else setCE(el, text);
      // Give React/Vue a beat to flush the controlled-input state.
      setTimeout(()=>{
        const btn = pickSendBtn();
        let sent = false;
        if(btn && !btn.disabled){ try{ btn.click(); sent = true; }catch{} }
        if(!sent){
          const form = el.closest("form");
          if(form){ try{ form.requestSubmit(); sent = true; }catch{ form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})); sent = true; } }
        }
        // Some sites accept Enter-to-send.
        if(!sent){
          el.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true,cancelable:true}));
          el.dispatchEvent(new KeyboardEvent("keypress",{key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true,cancelable:true}));
        }
        setTimeout(()=>clearEditor(el), 800);
        resolve(true);
      }, 250);
    });
  }

  // ── UI: launcher / status bar / activity feed ────────────────────────────
  const root = document.createElement("div");
  root.id = "rl-root";
  document.documentElement.appendChild(root);

  // Centered launcher
  const launcher = el("button", "rl-launcher");
  launcher.setAttribute("aria-label", "Start RoLink agent");
  launcher.innerHTML = `<span class="rl-logo">R</span><span class="rl-label">Start RoLink agent</span>`;
  root.appendChild(launcher);

  // Status bar (anchored above composer)
  const bar = el("div", "rl-bar");
  bar.id = "rl-bar";
  bar.style.display = "none";
  bar.innerHTML = `
    <span class="rl-dot" id="rl-dot"></span>
    <span class="rl-state" id="rl-state">RoLink: <small>…</small></span>
    <span class="rl-spacer"></span>
    <span class="rl-counter" id="rl-counter" title="Tools called this session">0 tools</span>
    <button class="rl-btn" id="rl-tools-btn" title="Show available tools">🛠 Tools</button>
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

  // Activity feed (right side, live scroll of every event)
  const feed = el("div", "rl-feed");
  feed.innerHTML = `
    <div class="rl-feed-head">
      <span class="rl-feed-title">Activity</span>
      <button class="rl-feed-clear" id="rl-feed-clear" title="Clear log">⌫</button>
    </div>
    <div class="rl-feed-list" id="rl-feed-list"></div>
  `;
  root.appendChild(feed);

  // Banner
  const banner = el("div", "rl-banner");
  banner.style.display = "none";
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
    while(list.children.length > 100) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
  }
  document.getElementById("rl-feed-clear").onclick = (e)=>{ e.stopPropagation(); document.getElementById("rl-feed-list").innerHTML=""; };

  // Status
  function setStatus(s){
    const dot = document.getElementById("rl-dot");
    const state = document.getElementById("rl-state");
    if(!dot || !state) return;
    dot.classList.remove("on","warn","err");
    if(s === "ready"){ dot.classList.add("on"); state.innerHTML = `RoLink: <small>Bridge + Studio ready</small>`; }
    else if(s === "studioOff"){ dot.classList.add("warn"); state.innerHTML = `RoLink: <small>enable MCP in Studio</small>`; }
    else if(s === "bridge"){ dot.classList.add("warn"); state.innerHTML = `RoLink: <small>Bridge OK, open Studio</small>`; }
    else { state.innerHTML = `RoLink: <small>offline — run start.bat</small>`; }
  }
  function setCounter(n){
    const c = document.getElementById("rl-counter");
    if(c) c.textContent = n + " tool" + (n === 1 ? "" : "s");
  }

  // Tools
  async function refreshTools(){
    const r = await bg({type:"list_tools"});
    const arr = (r && Array.isArray(r.tools)) ? r.tools : [];
    const list = document.getElementById("rl-tools-list");
    const count = document.getElementById("rl-tools-count");
    if(!list) return;
    if(!arr.length){
      list.textContent = r && r.error ? ("bridge: " + r.error) : "no tools — open Roblox Studio and enable MCP";
    } else {
      list.innerHTML = arr.map(t => {
        const nm = (typeof t === "string") ? t : (t.name || JSON.stringify(t));
        return `<span class="t" title="${escapeHtml((typeof t==="object"&&t&&t.description)||"")}">${escapeHtml(nm)}</span>`;
      }).join("");
    }
    if(count) count.textContent = arr.length + " available";
  }
  document.getElementById("rl-tools-btn").onclick = (e)=>{ e.stopPropagation(); toolsPanel.classList.toggle("rl-show"); };

  // Bar placement
  function findComposer(){
    const sels = ["textarea","[contenteditable='true']","[role='textbox']","form [data-testid*='input' i]"];
    for(const s of sels){ const el = document.querySelector(s); if(el && el.offsetParent !== null) return el; }
    return null;
  }
  function placeBar(){
    const composer = findComposer();
    if(!composer || composer.closest("#rl-root")) return;
    const rect = composer.getBoundingClientRect();
    if(!rect.width) return;
    const desiredWidth = Math.min(720, Math.max(320, rect.width));
    const vw = window.innerWidth;
    bar.style.left = Math.max(12, rect.left + (rect.width - desiredWidth)/2) + "px";
    bar.style.top = Math.max(8, rect.top - 40) + "px";
    bar.style.width = desiredWidth + "px";
    bar.style.display = "flex";
  }
  window.addEventListener("resize", placeBar);
  setInterval(placeBar, 1500);
  setTimeout(placeBar, 600);

  // ── tool chip helpers ────────────────────────────────────────────────────
  function makeToolChip(name, args){
    const chip = el("div", "rl-chip");
    const argsStr = args && Object.keys(args).length ? " " + JSON.stringify(args).slice(0,140) : "";
    chip.innerHTML = `<span class="rl-spinner"></span><span class="rl-ico">⚙</span><span><span class="rl-name">${escapeHtml(name)}</span><span style="opacity:.65">${escapeHtml(argsStr)}</span></span>`;
    return chip;
  }
  function chipFinalize(chip, name, res){
    chip.classList.remove("rl-err"); chip.classList.add(res.ok ? "rl-ok" : "rl-err");
    const ico = res.ok ? "✓" : "✗";
    let body = res.ok ? (res.text || "done") : (res.error || "failed");
    if(typeof body === "string" && body.length > 400) body = body.slice(0, 360) + "…";
    chip.innerHTML = `<span class="rl-ico">${ico}</span><span><span class="rl-name">${escapeHtml(name)}</span> <span style="opacity:.85;white-space:pre-wrap">${escapeHtml(String(body))}</span></span>`;
  }

  // ── ###MCP_TOOL### parser (brace-aware) ──────────────────────────────────
  function matchBrace(s, start){
    let depth = 0, inStr = false, esc = false, q = "";
    for(let i = start; i < s.length; i++){
      const c = s[i];
      if(inStr){ if(esc) esc = false; else if(c === "\\") esc = true; else if(c === q) inStr = false; }
      else {
        if(c === '"' || c === "'"){ inStr = true; q = c; }
        else if(c === "{") depth++;
        else if(c === "}"){ depth--; if(depth === 0) return i; }
      }
    }
    return -1;
  }
  function salvage(s){
    let o = (s.match(/\{/g) || []).length, c = (s.match(/\}/g) || []).length;
    if(o > c) s += "}".repeat(o - c);
    try{ return JSON.parse(s); }catch{ return null; }
  }
  function tryParseTool(text){
    if(!text) return null;
    text = text.replace(/<\|DSML\|>/g, "");
    // Find every ###MCP_TOOL### block
    const out = [];
    let i = 0;
    while(i < text.length){
      const m = text.indexOf("###MCP_TOOL###", i);
      if(m === -1) break;
      const b = text.indexOf("{", m);
      if(b === -1) break;
      const end = matchBrace(text, b);
      const chunk = end !== -1 ? text.slice(b, end + 1) : text.slice(b);
      let parsed = null;
      try{ parsed = JSON.parse(chunk); }catch{ parsed = salvage(chunk); }
      if(parsed) out.push(parsed);
      i = (end !== -1 ? end : b) + 1;
    }
    return out;
  }

  // ── check if a reply text contains a tool call (any marker) ───────────────
  function hasToolSignature(text){
    if(!text) return false;
    return /###MCP_TOOL###/.test(text) || /"command"\s*:/.test(text) || /"tool"\s*:/.test(text) || /"name"\s*:\s*"(execute_luau|run_code|create_instance|set_property|get_snapshot|delete_instance|search_assets|import_asset|generate_asset|start_stop_play|list_roblox_studios|get_studio_state|get_instance_tree|run_code_with_snapshot|insert_model|create_screen_capture|publish_place|publish_message|run_command|open_external)\b/.test(text);
  }

  // ── dispatch a parsed tool call ──────────────────────────────────────────
  function dispatchTool(parsed, sourceBlock){
    const name = parsed.tool || parsed.method || parsed.command || parsed.name || "run_code";
    const args = parsed.args || parsed.params || parsed.arguments || (parsed.command ? {} : {});
    if(sourceBlock && sourceBlock.parentElement){ sourceBlock.parentElement.style.display = "none"; }
    const chip = makeToolChip(name, args);
    if(sourceBlock && sourceBlock.parentElement && sourceBlock.parentElement.parentElement){
      sourceBlock.parentElement.parentElement.insertBefore(chip, sourceBlock.parentElement);
    } else {
      (sourceBlock || document.body).appendChild(chip);
    }
    S.busy = true;
    pushFeed("tool", "⚙", `${name} ${JSON.stringify(args).slice(0,140)}`);
    setCounter(++S.toolCount);
    bg({type:"call_tool", name, arguments: args, timeout: 120000}).then(res=>{
      S.busy = false;
      if(!res) res = {ok:false, error:"no response"};
      chipFinalize(chip, name, res);
      const text = res.ok ? (res.text || "OK") : ("ERROR: " + (res.error || "unknown"));
      const ok = res.ok !== false;
      pushFeed(ok ? "ok" : "err", ok ? "✓" : "✗", `${name}: ${String(text).slice(0,200).replace(/\n/g," ")}`);
      // Feed back
      S.consecutiveNudges = 0;
      const msg = ok
        ? `[Tool result for ${name}]\n${text}\n\nYou MUST continue. Either call another tool via ###MCP_TOOL### {json} OR give a final answer to the user. Do NOT respond with "I cannot run commands" — your tools are working.`
        : `[Tool error for ${name}]\n${text}\n\nThe tool call failed. Fix the call (correct args, valid JSON, valid Luau) and retry with another ###MCP_TOOL### block. If you can't fix it, explain the error to the user.`;
      setTimeout(()=>typeAndSend(msg), 200);
    });
  }

  // ── nudge when AI doesn't use a tool ─────────────────────────────────────
  function nudgeAI(reason){
    S.consecutiveNudges++;
    if(S.consecutiveNudges > S.maxNudges){
      pushFeed("err", "⏹", `Gave up after ${S.maxNudges} nudges with no tool call. Click Start to try again.`);
      S.running = false;
      launcher.classList.remove("is-active");
      launcher.innerHTML = `<span class="rl-logo">R</span><span class="rl-label">Start RoLink agent</span>`;
      document.getElementById("rl-stop-btn").style.display = "none";
      return;
    }
    let msg;
    if(reason === "question"){
      msg = `You just asked a clarifying question instead of using a tool. ASSUME the user's intent is "do something useful in the game" and call a tool now. Use ###MCP_TOOL### {json} format. If you really cannot proceed, do tool calls first then explain.`;
    } else {
      msg = `You just replied with plain text instead of calling a tool. Every reply in agent mode must either (1) call a tool via a single ###MCP_TOOL### {json} block, or (2) end with the exact word "DONE" if you have nothing left to do. Take the next step now.`;
    }
    pushFeed("nudge", "↻", `Nudge #${S.consecutiveNudges}: ${reason}`);
    setTimeout(()=>typeAndSend(msg), 300);
  }

  // ── process a new AI reply (the meat of the loop) ────────────────────────
  function processReply(text){
    if(!S.running) return;
    if(S.busy || S.injecting) return;
    // Strip "Continue" / "Regenerate" / reasoning-only replies
    const cleaned = String(text||"").trim();
    if(!cleaned) return;
    // Detect tool blocks first
    const tools = tryParseTool(cleaned);
    if(tools && tools.length){
      S.lastText = ""; S.lastTextTs = 0;
      tools.forEach((t, i) => {
        setTimeout(()=>dispatchTool(t), i * 50);
      });
      return;
    }
    if(hasToolSignature(cleaned)){
      // Has markers but parser failed -> nudge
      nudgeAI("malformed-tool");
      return;
    }
    // Plain text. If it's a short question, treat as asking for clarification; nudge.
    if(cleaned.length < 350 && /\?$/.test(cleaned)){
      pushFeed("nudge", "💬", `AI asked: "${cleaned.slice(0,140)}"`);
      nudgeAI("question");
      return;
    }
    // If we just fed a tool result and got a short "ok" back, nudge to continue.
    if(S.lastFeedTs && (Date.now() - S.lastFeedTs) < 30000 && cleaned.length < 200){
      nudgeAI("continue");
      return;
    }
    // Otherwise the AI is done.
    S.finished = true; S.running = false;
    pushFeed("done", "🏁", `Agent finished (${S.toolCount} tool call${S.toolCount === 1 ? "" : "s"}).`);
    launcher.classList.remove("is-active");
    launcher.innerHTML = `<span class="rl-logo">R</span><span class="rl-label">Start RoLink agent</span>`;
    document.getElementById("rl-stop-btn").style.display = "none";
  }

  // ── scan AI replies via MutationObserver ────────────────────────────────
  const seenNodes = new WeakSet();
  let lastReplyText = "";
  let lastReplyAt = 0;
  function getLatestAssistantText(){
    // Try provider-specific selectors first, fall back to "the last big block of text".
    const sels = [
      ".ds-markdown",                        // DeepSeek assistant
      ".ds-message .md:has(.ds-markdown)",
      "[data-message-author-role='assistant']",
      "[data-testid*='assistant' i]",
      "article[data-testid*='conversation-turn']:last-of-type",
      "div[data-message-author-role='assistant']",
      ".model-response",
      ".assistant-message",
      "[class*='assistant' i][class*='message' i]",
    ];
    for(const s of sels){
      const els = document.querySelectorAll(s);
      if(els && els.length){
        const last = els[els.length - 1];
        return (last.innerText || last.textContent || "").trim();
      }
    }
    return "";
  }
  function scanNode(node){
    if(!S.running) return;
    if(!node || node.nodeType !== 1) return;
    if(seenNodes.has(node)) return;
    // Any new <pre> containing a tool block?
    if(node.tagName === "PRE" || node.tagName === "CODE" || (node.querySelectorAll && node.querySelectorAll("pre, code").length)){
      const pres = node.tagName === "PRE" ? [node] : (node.querySelectorAll ? Array.from(node.querySelectorAll("pre code")) : []);
      for(const sub of pres){
        if(seenNodes.has(sub)) continue;
        const txt = sub.innerText || sub.textContent || "";
        if(!txt || txt.indexOf("###MCP_TOOL###") === -1) continue;
        seenNodes.add(sub);
        const parsed = tryParseTool(txt);
        if(parsed && parsed.length){ parsed.forEach((t, i)=>setTimeout(()=>dispatchTool(t, sub.parentElement || sub), i*50)); return; }
      }
    }
    // Else: poll latest assistant text once.
    debouncedCheckReply();
  }
  let replyCheckTimer = null;
  function debouncedCheckReply(){
    clearTimeout(replyCheckTimer);
    replyCheckTimer = setTimeout(checkReply, 800);
  }
  function checkReply(){
    if(!S.running) return;
    if(S.busy || S.injecting) return;
    const text = getLatestAssistantText();
    if(!text) return;
    if(text === lastReplyText) return;
    if(Date.now() - lastReplyAt < 500) return;
    lastReplyText = text;
    lastReplyAt = Date.now();
    processReply(text);
  }
  // Periodically re-poll the latest assistant text in case the observer misses it.
  setInterval(checkReply, 1500);

  function startObserver(){
    if(S.observeTarget) return;
    S.observeTarget = document.documentElement;
    const obs = new MutationObserver(muts=>{
      if(!S.running) return;
      for(const m of muts){ for(const n of m.addedNodes) scanNode(n); }
      debouncedCheckReply();
    });
    try{ obs.observe(document.documentElement, {childList:true, subtree:true, characterData:true}); }catch{}
  }

  // ── the system prompt that actually works ─────────────────────────────────
  const SYSTEM_PROMPT = `You are RoLink Agent v1.0 — you control Roblox Studio on the user's local PC through MCP tools.

EVERY reply you write MUST follow one of these two patterns:

1) To call a tool, output a single JSON code block like this (the block starts with ###MCP_TOOL### on its own line, then a JSON object on the next line):
###MCP_TOOL###
{"tool":"run_code","args":{"code":"print('hello')"}}

2) If you are completely done and have answered the user, end with the word DONE on its own line.

Available tools (you can call multiple per reply, one ###MCP_TOOL### block per call):
- run_code / execute_luau { code: "..." }  — run Luau in a sandbox
- create_instance { className, parent, name, properties }
- delete_instance { path }
- set_property { path, property, value }
- get_property { path, property }
- get_snapshot / get_instance_tree { maxDepth, filter }
- get_studio_state {}  — is a place open?
- list_roblox_studios {}  — which Studios are connected
- search_assets { keyword, limit, category }  — Creator Store
- import_asset { assetId, parent }
- generate_asset { prompt, kind }  — text-to-asset
- start_stop_play { action: "play"|"stop" }
- open_external { url }
- and more — the list shown in the "🛠 Tools" panel

Rules:
- Never claim you "cannot run commands" — your tools ARE working. Just output the right ###MCP_TOOL### block.
- Never ask the user clarifying questions before acting. Make reasonable assumptions and ACT.
- If a tool call fails, read the error and fix the call. Don't apologize and stop.
- Keep your prose short. The user wants to see tool calls and results, not essays.
- When the user's task is fully done and the place is in the desired state, give a one-sentence summary and end with DONE.`;

  const STARTER = `Start by taking a snapshot of the game tree so we can see what's there. Then ask the user what they want to build.`;

  // ── launcher click ──────────────────────────────────────────────────────
  launcher.addEventListener("click", ()=>{
    if(S.started){
      // Stop
      S.started = false; S.running = false; S.busy = false; S.injecting = false;
      launcher.classList.remove("is-active");
      launcher.innerHTML = `<span class="rl-logo">R</span><span class="rl-label">Start RoLink agent</span>`;
      document.getElementById("rl-stop-btn").style.display = "none";
      showBanner("Agent stopped. Click Start to run again.", "warn", 3500);
      pushFeed("err", "⏹", "Agent stopped by user.");
      return;
    }
    S.started = true; S.running = true; S.finished = false; S.toolCount = 0;
    S.consecutiveNudges = 0; S.lastText = ""; S.lastTextTs = 0; S.lastFeedTs = 0;
    setCounter(0);
    launcher.classList.add("is-active");
    launcher.innerHTML = `<span class="rl-stop-dot"></span><span class="rl-label">Stop agent</span>`;
    document.getElementById("rl-stop-btn").style.display = "inline-flex";
    bar.style.display = "flex";
    placeBar();
    setStatus("bridge");
    document.getElementById("rl-feed-list").innerHTML = "";
    pushFeed("info", "▶", `Agent started on ${location.hostname}`);
    showBanner("Agent started. Watching for tool calls…", "ok", 3000);
    startObserver();
    // First message: the system prompt + a starter. The AI will treat the system
    // prompt as instructions (it's in the user role, so the model sees it as
    // a directive user message). Then it will act.
    const first = SYSTEM_PROMPT + "\n\n---\n\n" + STARTER;
    setTimeout(()=>typeAndSend(first), 200);
  });
  document.getElementById("rl-stop-btn").addEventListener("click", ()=>launcher.click());

  // ── background status broadcasts ────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse)=>{
    if(!msg || !msg.type){ sendResponse({ok:false}); return; }
    if(msg.type === "rolink-status"){
      if(!msg.connected) setStatus("offline");
      else if(msg.mcpAlive && msg.studio === true) setStatus("ready");
      else if(msg.mcpAlive && msg.studio === false) setStatus("studioOff");
      else setStatus("bridge");
      sendResponse({ok:true}); return;
    }
    if(msg.type === "rolink-start"){
      if(!S.started){ launcher.click(); }
      sendResponse({ok:true, started:S.started}); return;
    }
    if(msg.type === "rolink-stop"){
      if(S.started){ launcher.click(); }
      sendResponse({ok:true, started:S.started}); return;
    }
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

  // Track our own feed-backs (so we know not to nudge on the immediate reply)
  const origTypeAndSend = typeAndSend;
  // (no override needed — we just track by timer in dispatchTool)

  // expose
  window.ROLINK = { start: ()=>launcher.click(), stop: ()=>{ if(S.started) launcher.click(); }, status: ()=>S, tools: ()=>[] };
})();
