// SPDX-License-Identifier: GPL-3.0-or-later
// core/main.js - RoLink in-page agent loop + UI.
//
// What this does:
//   1. Renders a centered "▶ Start agent" button (top-center of the page) and
//      a status bar (anchored above the chat composer). No matter what site.
//   2. On Start: injects a system prompt + a starter question into the AI's
//      input box, then auto-clicks Send.
//   3. Watches the AI's replies for ###MCP_TOOL### {json} blocks. For each
//      one, asks background.js to dispatch the tool, and replaces the raw
//      block with a beautiful tool chip showing the live result.
//   4. After the result, feeds it back to the AI (hidden) so the loop
//      continues automatically until the AI has nothing more to do.
//
// Routes every call through background.js (single bridge WS owner). Never
// opens a second WS from the page. Sits in a #rl-root shadow-DOM-like div
// so its CSS can't be clobbered by the host site.

(function(){
  "use strict";
  if(window.__rolink_injected) return; window.__rolink_injected=true;

  // ── chrome.runtime.sendMessage wrapper with offline fallback ──────────────
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
        if(/Extension context invalidated|message port closed/i.test(String(e))){
          bgAvailable = false;
          return resolve({ok:false, kind:"stale-extension", error:String(e)});
        }
        resolve({ok:false, error:String(e)});
      }
    });
  }

  // ── shared state ─────────────────────────────────────────────────────────
  const S = {
    started: false,          // user clicked Start
    injecting: false,        // currently feeding a result back to the AI
    busy: false,             // a tool is currently executing
    toolRunningName: "",
    lastActivityTs: 0,
    lastFeedAt: 0,
    feedStreak: 0,           // how many tool-results we've fed back in a row (for stall detection)
    observeTarget: null,
    status: "offline",       // offline | bridge | studioOff | ready
    tools: [],
  };

  // ── UI elements ──────────────────────────────────────────────────────────
  const root = document.createElement("div");
  root.id = "rl-root";
  document.documentElement.appendChild(root);

  // Centered launcher
  const launcher = document.createElement("button");
  launcher.className = "rl-launcher";
  launcher.setAttribute("aria-label", "Start RoLink agent");
  launcher.innerHTML = `<span class="rl-logo">R</span><span class="rl-label">Start RoLink agent</span>`;
  root.appendChild(launcher);

  // Status bar
  const bar = document.createElement("div");
  bar.id = "rl-bar";
  bar.style.display = "none";
  bar.innerHTML = `
    <span class="rl-dot" id="rl-dot"></span>
    <span class="rl-state" id="rl-state">RoLink: <small>…</small></span>
    <span class="rl-spacer"></span>
    <button class="rl-btn" id="rl-tools-btn" title="Show available tools">🛠 Tools</button>
    <button class="rl-btn" id="rl-stop-btn" class="rl-btn warn" style="display:none" title="Stop the agent">■ Stop</button>
  `;
  root.appendChild(bar);

  // Tools panel
  const toolsPanel = document.createElement("div");
  toolsPanel.className = "rl-tools";
  toolsPanel.innerHTML = `
    <div class="rl-tools-head">Tools <span class="pill" id="rl-tools-count">-</span></div>
    <div class="rl-tools-list" id="rl-tools-list">Loading…</div>
  `;
  root.appendChild(toolsPanel);

  // Banner (transient guidance)
  const banner = document.createElement("div");
  banner.className = "rl-banner";
  banner.style.display = "none";
  root.appendChild(banner);

  function showBanner(text, kind, ms){
    banner.textContent = text;
    banner.className = "rl-banner" + (kind ? " " + kind : "");
    banner.style.display = "block";
    clearTimeout(banner._t);
    if(ms) banner._t = setTimeout(()=>{ banner.style.display = "none"; }, ms);
  }
  function hideBanner(){ banner.style.display = "none"; }

  // ── status / dot ─────────────────────────────────────────────────────────
  function setStatus(s){
    S.status = s;
    const dot = document.getElementById("rl-dot");
    const state = document.getElementById("rl-state");
    if(!dot || !state) return;
    dot.classList.remove("on","warn","err");
    if(s === "ready"){ dot.classList.add("on"); state.innerHTML = `RoLink: <small>Bridge + Studio ready</small>`; }
    else if(s === "studioOff"){ dot.classList.add("warn"); state.innerHTML = `RoLink: <small>enable MCP in Studio</small>`; }
    else if(s === "bridge"){ dot.classList.add("warn"); state.innerHTML = `RoLink: <small>Bridge OK, open Studio</small>`; }
    else { state.innerHTML = `RoLink: <small>offline — run start.bat</small>`; }
  }

  // ── tools panel ──────────────────────────────────────────────────────────
  async function refreshTools(){
    const r = await bg({type:"list_tools"});
    const arr = (r && Array.isArray(r.tools)) ? r.tools : [];
    S.tools = arr;
    const list = document.getElementById("rl-tools-list");
    const count = document.getElementById("rl-tools-count");
    if(!list) return;
    if(!arr.length){
      list.textContent = r && r.error ? ("bridge: " + r.error) : "no tools — open Roblox Studio";
    } else {
      list.innerHTML = arr.map(t => {
        const nm = (typeof t === "string") ? t : (t.name || JSON.stringify(t));
        return `<span class="t" title="${(typeof t==="object"&&t.description)||""}">${escapeHtml(nm)}</span>`;
      }).join("");
    }
    if(count) count.textContent = arr.length + " available";
  }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);}

  document.getElementById("rl-tools-btn").onclick = ()=>{
    toolsPanel.classList.toggle("rl-show");
  };

  // ── bar placement (above the chat composer) ─────────────────────────────
  function findComposer(){
    const sels = ["textarea","[contenteditable='true']","[role='textbox']","form [data-testid*='input' i]"];
    for(const s of sels){ const el = document.querySelector(s); if(el) return el; }
    return null;
  }
  function placeBar(){
    const composer = findComposer();
    if(!composer) return;
    // Skip if composer is itself the bar (avoid re-anchoring)
    if(composer.closest("#rl-bar") || composer.closest("#rl-root")) return;
    const rect = composer.getBoundingClientRect();
    if(!rect.width) return;
    const vw = window.innerWidth;
    const desiredWidth = Math.min(720, Math.max(320, rect.width));
    bar.style.left = Math.max(12, rect.left + (rect.width - desiredWidth)/2) + "px";
    bar.style.top = Math.max(8, rect.top - 38) + "px";
    bar.style.width = desiredWidth + "px";
    bar.style.display = "flex";
  }
  window.addEventListener("resize", placeBar);
  setInterval(placeBar, 1500);
  setTimeout(placeBar, 600);

  // ── tool call chip helpers ───────────────────────────────────────────────
  function makeToolChip(name, args){
    const chip = document.createElement("div");
    chip.className = "rl-chip";
    const argsStr = args && Object.keys(args).length ? " " + JSON.stringify(args).slice(0,120) : "";
    chip.innerHTML = `<span class="rl-spinner"></span><span class="rl-ico">⚙</span><span><span class="rl-name">${escapeHtml(name)}</span><span style="opacity:.65">${escapeHtml(argsStr)}</span></span>`;
    return chip;
  }
  function chipFinalize(chip, name, res){
    chip.classList.remove("rl-err"); chip.classList.add(res.ok ? "rl-ok" : "rl-err");
    const ico = res.ok ? "✓" : "✗";
    let body = res.ok ? (res.text || "done") : (res.error || "failed");
    if(typeof body === "string" && body.length > 300) body = body.slice(0, 280) + "…";
    chip.innerHTML = `<span class="rl-ico">${ico}</span><span><span class="rl-name">${escapeHtml(name)}</span> <span style="opacity:.85">${escapeHtml(String(body))}</span></span>`;
  }

  // ── provider-specific: find the AI's input box + send button ─────────────
  function pickInput(){
    const sels = [
      "textarea",
      "[contenteditable='true']",
      "[role='textbox']",
      "div[data-testid='chat-input']",
      "textarea[data-testid='chat-input']",
      "textarea[placeholder*='Message' i]",
      "textarea[placeholder*='Ask' i]",
      "textarea[placeholder*='Send' i]",
      "textarea[placeholder*='Type' i]",
      "div[aria-label*='message' i][contenteditable='true']",
    ];
    for(const s of sels){ const el = document.querySelector(s); if(el && el.offsetParent !== null) return el; }
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
    for(const s of sels){ const el = document.querySelector(s); if(el && !el.disabled) return el; }
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

  // ── system prompt + starter ──────────────────────────────────────────────
  const SYSTEM_REMINDER = `[RoLink Agent: you control Roblox Studio via MCP tools running on the user's PC.
Output a SINGLE JSON code block per tool call:
###MCP_TOOL###
{"tool":"run_code","args":{"code":"print('hi')"}}
You can call multiple tools in one reply (one JSON block per call). The result of every tool is fed back to you automatically so you can decide the next step. Never claim you cannot run commands.]`;
  const STARTER = "\n\nHi! I'm RoLink Agent — connected to your local Roblox Studio. What would you like to build? Try: 'create a Part named Roof in workspace', 'snapshot the game tree', 'run print(1+1)', or 'plan an obby'.";

  function injectAndSend(){
    const el = pickInput();
    if(!el){ setTimeout(injectAndSend, 400); return; }
    el.focus();
    const val = SYSTEM_REMINDER + STARTER;
    if(el.tagName === "TEXTAREA") setReactValue(el, val);
    else setCE(el, val);
    setTimeout(()=>{
      const btn = pickSendBtn();
      if(btn && !btn.disabled){ try{ btn.click(); }catch{} }
      else { const form = el.closest("form"); if(form){ try{ form.requestSubmit(); }catch{ form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})); } } }
      S.lastActivityTs = Date.now();
    }, 250);
  }
  function feedResultToAI(text){
    const el = pickInput();
    if(!el || S.injecting){ return false; }
    S.injecting = true;
    el.focus();
    const msg = `[Tool result]\n${text}\n\nUse this result to decide your next step. Reply with another ###MCP_TOOL### block, or answer the user in plain text when done.`;
    if(el.tagName === "TEXTAREA") setReactValue(el, msg);
    else setCE(el, msg);
    setTimeout(()=>{
      const btn = pickSendBtn();
      if(btn && !btn.disabled){ try{ btn.click(); }catch{} }
      else { const form = el.closest("form"); if(form){ try{ form.requestSubmit(); }catch{ form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})); } } }
      setTimeout(()=>{ clearEditor(el); S.injecting = false; }, 500);
    }, 250);
    S.lastFeedAt = Date.now();
    return true;
  }

  // ── ###MCP_TOOL### JSON parser (brace-aware, tolerates tabs / cutoffs) ──
  function matchBrace(s, start){
    let depth = 0, inStr = false, esc = false, q = "";
    for(let i = start; i < s.length; i++){
      const c = s[i];
      if(inStr){
        if(esc) esc = false;
        else if(c === "\\") esc = true;
        else if(c === q) inStr = false;
      } else {
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
    text = text.replace(/<\|DSML\|>/g, "");
    const m = text.indexOf("###MCP_TOOL###");
    if(m === -1) return null;
    const b = text.indexOf("{", m);
    if(b === -1) return null;
    const end = matchBrace(text, b);
    const chunk = end !== -1 ? text.slice(b, end + 1) : text.slice(b);
    try{ return JSON.parse(chunk); }
    catch{ return salvage(chunk); }
  }

  // ── agent loop: scan new <pre> blocks, dispatch, feed back ─────────────
  const seenBlocks = new WeakSet();
  const inflight = new Map(); // chip element -> {name, args, promise}

  function isToolBlock(node){
    if(!node || !node.innerText) return false;
    if(node.innerText.indexOf("###MCP_TOOL###") === -1) return false;
    return true;
  }

  function dispatchTool(parsed, sourceBlock){
    if(!S.started) return;
    const name = parsed.tool || parsed.method || parsed.name || "run_code";
    const args = parsed.args || parsed.params || parsed.arguments || {};
    // visual: hide raw block, insert chip
    if(sourceBlock && sourceBlock.parentElement){ sourceBlock.parentElement.style.display = "none"; }
    const chip = makeToolChip(name, args);
    if(sourceBlock && sourceBlock.parentElement && sourceBlock.parentElement.parentElement){
      sourceBlock.parentElement.parentElement.insertBefore(chip, sourceBlock.parentElement);
    } else {
      (sourceBlock || document.body).appendChild(chip);
    }
    S.busy = true; S.toolRunningName = name; S.lastActivityTs = Date.now();
    bg({type:"call_tool", name, arguments: args, timeout: 120000}).then(res=>{
      S.busy = false; S.toolRunningName = ""; S.lastActivityTs = Date.now();
      if(!res) res = {ok:false, error:"no response"};
      chipFinalize(chip, name, res);
      // Feed the result back to the AI (hidden) so it can continue.
      const text = res.ok ? (res.text || "OK") : ("ERROR: " + (res.error || "unknown"));
      const ok = res.ok !== false;
      if(ok){
        S.feedStreak = Math.min(20, (S.feedStreak || 0) + 1);
        feedResultToAI(`${name} result:\n${text}`);
      } else {
        S.feedStreak = 0;
        feedResultToAI(`${name} failed:\n${text}\n\nPlease fix the tool call and try again, or explain the error to the user.`);
      }
    });
  }

  function scanNode(node){
    if(!node || node.nodeType !== 1) return;
    // find <pre><code> blocks containing ###MCP_TOOL###
    if(node.tagName === "PRE" && node.children.length === 1 && node.firstElementChild.tagName === "CODE"){
      if(seenBlocks.has(node)) return;
      if(!isToolBlock(node)) return;
      seenBlocks.add(node);
      const parsed = tryParseTool(node.innerText);
      if(parsed) dispatchTool(parsed, node);
      return;
    }
    // recurse
    const all = node.querySelectorAll ? node.querySelectorAll("pre code") : [];
    for(const sub of all){
      if(seenBlocks.has(sub.parentElement || sub)) continue;
      if(!isToolBlock(sub)) continue;
      const pre = sub.parentElement || sub;
      seenBlocks.add(pre);
      const parsed = tryParseTool(sub.innerText);
      if(parsed) dispatchTool(parsed, pre);
    }
  }

  function startObserver(){
    if(S.observeTarget) return;
    S.observeTarget = document.documentElement;
    const obs = new MutationObserver(muts=>{
      if(!S.started) return;
      for(const m of muts){
        for(const n of m.addedNodes){ scanNode(n); }
      }
    });
    try{ obs.observe(document.documentElement, {childList:true, subtree:true}); }catch{}
  }

  // ── launcher click ───────────────────────────────────────────────────────
  launcher.addEventListener("click", ()=>{
    if(S.started){
      // already running -> stop
      S.started = false;
      S.busy = false;
      launcher.classList.remove("is-active");
      launcher.innerHTML = `<span class="rl-logo">R</span><span class="rl-label">Start RoLink agent</span>`;
      showBanner("Agent stopped. Reload the page to clear the chips.", "warn", 4000);
      bg({type:"log", level:"warn", text:"Agent stopped by user."});
      return;
    }
    S.started = true;
    launcher.classList.add("is-active");
    launcher.innerHTML = `<span class="rl-stop-dot"></span><span class="rl-label">Stop agent</span>`;
    hideBanner();
    bar.style.display = "flex";
    placeBar();
    setStatus("bridge");
    bg({type:"log", level:"ok", text:"Agent started in "+location.hostname});
    showBanner("Agent started — sending system prompt + starter to the AI.", "ok", 3500);
    injectAndSend();
    startObserver();
  });

  // ── background status broadcasts ────────────────────────────────────────
  chrome.runtime.onMessage.addListener(msg=>{
    if(!msg || !msg.type) return;
    if(msg.type === "rolink-status"){
      if(!msg.connected) setStatus("offline");
      else if(msg.mcpAlive && msg.studio === true) setStatus("ready");
      else if(msg.mcpAlive && msg.studio === false) setStatus("studioOff");
      else setStatus("bridge");
    }
  });
  // Periodic poll fallback (the broadcast above can race with page reload).
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
  // initial
  bg({type:"status"}).then(s=>{ if(s){ if(!s.connected) setStatus("offline"); else setStatus("bridge"); } });
  refreshTools();

  // expose for debug
  window.ROLINK = { start:()=>launcher.click(), status:()=>S, tools:()=>S.tools };
})();
