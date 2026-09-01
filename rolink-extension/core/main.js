// RoLink core/main.js — overlay + agentic loop, provider-agnostic
(function(){
  const BRIDGE = "ws://127.0.0.1:17613";
  let ws=null, status="offline", pending=new Map();
  const bar = document.createElement("div");
  bar.id="rolink-bar";
  bar.innerHTML = `
    <span id="rolink-dot" style="width:10px;height:10px;border-radius:50%;background:grey;display:inline-block;box-shadow:0 0 6px transparent;transition:all .3s"></span>
    <span id="rolink-text" style="font-weight:500">RoLink: offline</span>
    <span style="flex:1"></span>
    <button id="rolink-start" title="Start agent: injects system prompt + starter into this chat" style="background:#2f81f7;border:none;color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;font:11px system-ui;font-weight:500">▶ Start agent</button>
    <button id="rolink-reconnect" style="background:transparent;border:1px solid #444;color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;font:11px system-ui">Reconnect</button>
    <button id="rolink-options" title="Settings" style="background:transparent;border:1px solid #444;color:#fff;padding:4px 8px;border-radius:6px;cursor:pointer;font:11px system-ui">⚙</button>
  `;
  bar.style.cssText="position:fixed;bottom:0;left:0;right:0;background:linear-gradient(180deg,#161b22,#0e1116);color:#e6edf3;padding:8px 12px;z-index:999999;font:12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;gap:8px;box-shadow:0 -2px 12px rgba(0,0,0,.4);border-top:1px solid #262d36";
  function injectBar(){ const anchor=document.querySelector('form, [role="textbox"], textarea'); if(anchor && !document.getElementById("rolink-bar")) (anchor.parentElement||document.body).appendChild(bar); }
  setInterval(injectBar, 1500);
  injectBar();
  const dot=()=>document.getElementById("rolink-dot"), txt=()=>document.getElementById("rolink-text");
  function setStatus(s){
    status=s;
    const d=dot(), t=txt();
    if(!d||!t) return;
    if(s==="ready"){ d.style.background="#3fb950"; d.style.boxShadow="0 0 8px rgba(63,185,80,.6)"; t.textContent="RoLink: Bridge + Studio ready"; }
    else if(s==="bridge"){ d.style.background="#d29922"; d.style.boxShadow="0 0 8px rgba(210,153,34,.6)"; t.textContent="RoLink: Bridge OK, open Studio place"; }
    else { d.style.background="#6e7681"; d.style.boxShadow="none"; t.textContent="RoLink: offline — run start.bat"; }
  }
  function connect(){
    try{ ws=new WebSocket(BRIDGE+"/ws?role=extension&token=dummy"); }catch{ setStatus("offline"); return; }
    ws.onopen=()=> setStatus("bridge");
    ws.onclose=()=>{ setStatus("offline"); setTimeout(connect, 3000); };
    ws.onmessage=(e)=>{
      try{
        const m=JSON.parse(e.data);
        if(m.result && m.result.ok===false && m.result.error) console.warn("[RoLink] tool error", m.result.error);
        const id=m.id; if(pending.has(id)){ pending.get(id)(m.result); pending.delete(id); }
        if(m.method==="result" && m.payload) handleToolResult(m.payload);
        if(m.result && m.result.bridge==17613 && m.result.servers && m.result.servers.length>0) setStatus("ready");
      }catch{}
    };
  }
  connect();
  setInterval(()=>{ if(ws && ws.readyState===1) ws.send(JSON.stringify({id:"hb",method:"heartbeat"})); else connect(); }, 10000);

  function handleToolResult(payload){
    const chip=document.createElement("div");
    chip.textContent="Reminder: "+ buildSystemPrompt(window.ROLINK_PROVIDER||"deepseek").slice(0,300);
    chip.style.display="none"; chip.setAttribute("data-rolink-reminder","");
    document.body.appendChild(chip);
  }

  let started=false;
  document.addEventListener("click", (e)=>{
    const t=e.target;
    if(t && t.id==="rolink-start"){
      if(started){ return; }
      try{ chrome.runtime.sendMessage({type:"start_agent"}); }catch{}
      started=true; setStatus("ready"); t.textContent="✓ Active"; t.style.background="#3fb950"; t.disabled=true;
    }
    if(t && t.id==="rolink-reconnect"){ connect(); }
    if(t && t.id==="rolink-options"){ try{ chrome.runtime.sendMessage({type:"reconnect"}); }catch{} if(typeof chrome!=="undefined"&&chrome.runtime&&chrome.runtime.openOptionsPage){ try{ chrome.runtime.openOptionsPage(); }catch{ window.open(chrome.runtime.getURL("options.html")); } } else { window.open(chrome.runtime.getURL("options.html")); } }
  });
  const obs=new MutationObserver(()=>{
    const blocks=document.querySelectorAll("pre code");
    if(!blocks.length) return;
    const last=blocks[blocks.length-1];
    const text=last.innerText;
    const parsed=typeof ZSParse!=="undefined"? ZSParse(text): null;
    if(parsed && started && ws && ws.readyState===1){
      const id="tool-"+Date.now();
      ws.send(JSON.stringify({id, ...parsed}));
      last.parentElement.style.display="none";
      const chip=document.createElement("div");
      chip.textContent="🔧 RoLink tool: "+(parsed.tool||parsed.method||"run")+"…";
      chip.style.cssText="background:linear-gradient(135deg,#2f81f7,#1f6feb);color:#fff;padding:4px 10px;border-radius:6px;font:11px monospace;margin:4px 0;display:inline-block;box-shadow:0 2px 6px rgba(47,129,247,.3)";
      last.parentElement.parentElement.insertBefore(chip, last.parentElement);
      try{ chrome.runtime.sendMessage({type:"log",level:"ok",text:"🔧 "+(parsed.tool||parsed.method||"run")}); }catch{}
    }
  });
  try{ obs.observe(document.documentElement,{childList:true,subtree:true}); }catch{}
  window.ROLINK_STARTED=()=> started;
})();
