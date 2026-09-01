// RoLink core/main.js - thin content-script glue for the AI tab.
// Routes every tool call through the background service worker (which owns
// the single bridge WebSocket) instead of opening a second WS from the page
// (a second WS is fine, but going through bg() gives us: the AI tab never
// sees the bridge go offline, the SW can retry/reconnect transparently, and
// we get response correlation for free). The MutationObserver below scans
// for ###MCP_TOOL### {json} blocks and asks bg() to dispatch them.
(function(){
  "use strict";
  if(window.__rolink_injected) return; window.__rolink_injected=true;

  function bg(msg){
    return new Promise(resolve=>{
      try{
        chrome.runtime.sendMessage(msg, resp=>{
          if(chrome.runtime.lastError) return resolve({ok:false, error:chrome.runtime.lastError.message});
          resolve(resp || {ok:false, error:"no response"});
        });
      }catch(e){ resolve({ok:false, error:String(e)}); }
    });
  }

  function pickInput(){
    const sels=[
      "textarea",
      "[contenteditable='true']",
      "div[role='textbox']",
      "[data-testid='chat-input']",
      "textarea[data-testid='chat-input']",
      "textarea[placeholder*='Message']",
      "textarea[placeholder*='Ask']",
      "textarea[placeholder*='Send']",
      "textarea[placeholder*='Type']"
    ];
    for(const s of sels){ const el=document.querySelector(s); if(el) return el; }
    return null;
  }
  function setReactValue(el,val){
    const proto=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLDivElement.prototype;
    const setter=Object.getOwnPropertyDescriptor(proto,"value")?.set;
    if(setter){ setter.call(el,val); el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true})); }
    else { el.value=val; el.dispatchEvent(new Event("input",{bubbles:true})); }
  }
  function setCE(el,val){
    el.focus();
    try{ document.execCommand("selectAll",false,null); document.execCommand("insertText",false,val); return; }catch{}
    el.innerText=val;
    el.dispatchEvent(new InputEvent("input",{bubbles:true,data:val,inputType:"insertText"}));
  }

  const bar=document.createElement("div");
  bar.id="rolink-bar";
  bar.innerHTML=`
    <span id="rolink-dot" style="width:10px;height:10px;border-radius:50%;background:grey;display:inline-block;box-shadow:0 0 6px transparent;transition:all .3s"></span>
    <span id="rolink-text" style="font-weight:500">RoLink: …</span>
    <span style="flex:1"></span>
    <button id="rolink-start" title="Start agent: injects system prompt + starter into this chat" style="background:#2f81f7;border:none;color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;font:11px system-ui;font-weight:500">▶ Start agent</button>
    <button id="rolink-reconnect" style="background:transparent;border:1px solid #444;color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;font:11px system-ui">Reconnect</button>
  `;
  bar.style.cssText="position:fixed;bottom:0;left:0;right:0;background:linear-gradient(180deg,#161b22,#0e1116);color:#e6edf3;padding:8px 12px;z-index:999999;font:12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;gap:8px;box-shadow:0 -2px 12px rgba(0,0,0,.4);border-top:1px solid #262d36";
  function injectBar(){ const anchor=document.querySelector('form, [role="textbox"], textarea'); if(anchor && !document.getElementById("rolink-bar")) (anchor.parentElement||document.body).appendChild(bar); }
  setInterval(injectBar, 1500);
  injectBar();
  const dot=()=>document.getElementById("rolink-dot"), txt=()=>document.getElementById("rolink-text");
  function setStatus(s){
    const d=dot(), t=txt(); if(!d||!t) return;
    if(s==="ready"){ d.style.background="#3fb950"; d.style.boxShadow="0 0 8px rgba(63,185,80,.6)"; t.textContent="RoLink: Bridge + Studio ready"; }
    else if(s==="bridge"){ d.style.background="#d29922"; d.style.boxShadow="0 0 8px rgba(210,153,34,.6)"; t.textContent="RoLink: Bridge OK, open Studio place"; }
    else if(s==="studioOff"){ d.style.background="#d29922"; d.style.boxShadow="0 0 8px rgba(210,153,34,.6)"; t.textContent="RoLink: enable MCP in Studio"; }
    else { d.style.background="#6e7681"; d.style.boxShadow="none"; t.textContent="RoLink: offline — run start.bat"; }
  }

  // status updates from background
  chrome.runtime.onMessage.addListener(msg=>{
    if(msg && msg.type==="rolink-status"){
      if(!msg.connected) setStatus("offline");
      else if(msg.mcpAlive && msg.studio===true) setStatus("ready");
      else if(msg.mcpAlive && msg.studio===false) setStatus("studioOff");
      else setStatus("bridge");
    }
  });
  setInterval(()=>{ bg({type:"status"}).then(s=>{ if(!s) return; if(!s.connected) setStatus("offline"); }); }, 3000);
  bg({type:"status"}).then(s=>{ if(!s||!s.connected) setStatus("offline"); });

  const SYSTEM_REMINDER=`[RoLink Agent: you control Roblox Studio via MCP tools. To call a tool, output a single JSON code block like:
###MCP_TOOL###
{"tool":"run_code","args":{"code":"print('hi')"}}
Common tools: run_code (Luau sandbox), execute_luau, get_studio_state, list_roblox_studios, get_instance_tree, search_assets, import_asset, run_code_with_snapshot, start_stop_play, screen_capture. Always call tools via ###MCP_TOOL###. Never claim you cannot run commands.]`;
  const STARTER="\n\nHi! I'm RoLink Agent. What would you like to build in Roblox Studio? Try asking me to create a Part, run Luau, take a snapshot, or plan an obby.";

  function injectAndSend(){
    const el=pickInput(); if(!el){ setTimeout(injectAndSend,500); return; }
    el.focus();
    const val=SYSTEM_REMINDER+STARTER;
    if(el.tagName==="TEXTAREA") setReactValue(el,val); else setCE(el,val);
    setTimeout(()=>{
      const sendBtn=document.querySelector("button[data-testid='send-button'], button[aria-label*='Send' i], button[aria-label*='Submit' i], form button[type='submit']");
      if(sendBtn && !sendBtn.disabled){ try{ sendBtn.click(); }catch{} }
      else { const form=el.closest("form"); if(form){ try{ form.requestSubmit(); }catch{ form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})); } } }
    }, 250);
  }

  let started=false;
  document.addEventListener("click", e=>{
    const t=e.target;
    if(t && t.id==="rolink-start"){
      if(started) return;
      started=true; setStatus("ready");
      t.textContent="✓ Active"; t.style.background="#3fb950"; t.disabled=true;
      injectAndSend();
    }
    if(t && t.id==="rolink-reconnect"){ bg({type:"reconnect"}); setTimeout(()=>bg({type:"status"}).then(s=>{ if(!s||!s.connected) setStatus("offline"); }),500); }
  });

  // agentic loop: parse AI's ###MCP_TOOL### blocks and dispatch via background
  function tryZSParse(text){
    const m=text.indexOf("###MCP_TOOL###");
    if(m===-1) return null;
    const b=text.indexOf("{",m); if(b===-1) return null;
    let depth=0, inStr=false, esc=false, q="";
    for(let i=b;i<text.length;i++){
      const c=text[i];
      if(inStr){
        if(esc) esc=false;
        else if(c==="\\") esc=true;
        else if(c===q) inStr=false;
      } else {
        if(c==='"'||c==="'"){ inStr=true; q=c; }
        else if(c==="{") depth++;
        else if(c==="}"){ depth--; if(depth===0) return JSON.parse(text.slice(b,i+1)); }
      }
    }
    return null;
  }

  const obs=new MutationObserver(()=>{
    if(!started) return;
    const blocks=document.querySelectorAll("pre code");
    if(!blocks.length) return;
    for(let i=blocks.length-1;i>=0;i--){
      const last=blocks[i];
      if(last.getAttribute("data-rolink-scanned")) continue;
      last.setAttribute("data-rolink-scanned","1");
      const text=last.innerText;
      const parsed=tryZSParse(text);
      if(!parsed) continue;
      const payload={
        type:"call_tool",
        name: parsed.tool || parsed.method || "run_code",
        arguments: parsed.args || parsed.params || parsed.arguments || {},
        timeout: 120000,
      };
      // dispatch via background service worker (owns the bridge WS)
      bg(payload).then(res=>{
        if(!res) return;
        // replace the raw block with a chip showing the result
        last.parentElement.style.display="none";
        const chip=document.createElement("div");
        const ok = res.ok !== false;
        chip.textContent = (ok?"✓ ":"✗ ") + payload.name + (res.text?": "+String(res.text).slice(0,140):(res.error?" — "+res.error:""));
        chip.style.cssText="background:"+(ok?"linear-gradient(135deg,#3fb950,#2da043)":"linear-gradient(135deg,#f85149,#da3633)")+";color:#fff;padding:4px 10px;border-radius:6px;font:11px monospace;margin:4px 0;display:inline-block;box-shadow:0 2px 6px rgba(0,0,0,.3)";
        last.parentElement.parentElement.insertBefore(chip, last.parentElement);
        bg({type:"log", level:ok?"ok":"error", text: (ok?"✓ ":"✗ ")+payload.name});
      });
    }
  });
  try{ obs.observe(document.documentElement,{childList:true,subtree:true}); }catch{}
  window.ROLINK_STARTED=()=> started;
})();
