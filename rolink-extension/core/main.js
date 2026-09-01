// RoLink core/main.js — overlay + agentic loop, provider-agnostic
(function(){
  const BRIDGE = "ws://127.0.0.1:17613";
  let ws=null, status="offline", pending=new Map();
  const bar = document.createElement("div");
  bar.id="rolink-bar";
  bar.innerHTML = `<span id="rolink-dot" style="width:10px;height:10px;border-radius:50%;background:grey;display:inline-block"></span> <span id="rolink-text">RoLink: offline — run start.bat</span> <button id="rolink-start" style="margin-left:8px">Start session</button> <button id="rolink-reconnect">Reconnect</button>`;
  bar.style.cssText="position:fixed;bottom:0;left:0;right:0;background:#111;color:#fff;padding:6px 10px;z-index:999999;font:12px system-ui;display:flex;align-items:center;gap:6px";
  function injectBar(){ const anchor=document.querySelector('form, [role="textbox"], textarea'); if(anchor && !document.getElementById("rolink-bar")) (anchor.parentElement||document.body).appendChild(bar); }
  setInterval(injectBar, 1000);
  injectBar();
  const dot=()=>document.getElementById("rolink-dot"), txt=()=>document.getElementById("rolink-text");
  function setStatus(s){
    status=s;
    const d=dot(), t=txt();
    if(!d||!t) return;
    if(s==="ready"){ d.style.background="green"; t.textContent="RoLink: Bridge + Studio ready"; }
    else if(s==="bridge"){ d.style.background="yellow"; t.textContent="RoLink: Bridge OK, open Studio place"; }
    else { d.style.background="grey"; t.textContent="RoLink: offline — run start.bat"; }
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
      }catch{}
    };
  }
  connect();
  setInterval(()=>{ if(ws && ws.readyState===1) ws.send(JSON.stringify({id:"hb",method:"heartbeat"})); else connect(); }, 10000);

  function handleToolResult(payload){
    // inject hidden Reminder chip with system prompt to prevent ChatGPT forgetting
    const chip=document.createElement("div");
    chip.textContent="Reminder: "+ buildSystemPrompt(window.ROLINK_PROVIDER||"deepseek").slice(0,300);
    chip.style.display="none"; chip.setAttribute("data-rolink-reminder","");
    document.body.appendChild(chip);
  }

  // agentic loop: intercept provider's chat send, inject system prompt once
  let started=false;
  document.addEventListener("click", (e)=>{
    const t=e.target;
    if(t && t.id==="rolink-start"){ started=true; setStatus("ready"); t.textContent="Session active"; ws && ws.send(JSON.stringify({id:"start",method:"add_server",name:"rolink",command:"bridge.py"})); }
    if(t && t.id==="rolink-reconnect"){ connect(); }
  });
  // Watch for AI responses and trigger tool execution via WS
  const obs=new MutationObserver(()=>{
    const blocks=document.querySelectorAll("pre code");
    if(!blocks.length) return;
    const last=blocks[blocks.length-1];
    const text=last.innerText;
    const parsed=typeof ZSParse!=="undefined"? ZSParse(text): null;
    if(parsed && started && ws && ws.readyState===1){
      const id="tool-"+Date.now();
      ws.send(JSON.stringify({id, ...parsed}));
      // hide raw block chip
      last.parentElement.style.display="none";
      const chip=document.createElement("div");
      chip.textContent="🔧 RoLink tool: "+(parsed.tool||parsed.method||"run")+"…";
      chip.style.cssText="background:#1a73e8;color:#fff;padding:4px 8px;border-radius:6px;font:11px monospace;margin:4px 0";
      last.parentElement.parentElement.insertBefore(chip, last.parentElement);
    }
  });
  try{ obs.observe(document.documentElement,{childList:true,subtree:true}); }catch{}
  window.ROLINK_STARTED=()=> started;
})();
