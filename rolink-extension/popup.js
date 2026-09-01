const dot=document.getElementById("dot"), txt=document.getElementById("statustxt");
const bridgeEl=document.getElementById("bridgeUrl"), mcpEl=document.getElementById("mcpUrl");
const upEl=document.getElementById("uptime"), serversEl=document.getElementById("servers");
const verEl=document.getElementById("ver"), toolCountEl=document.getElementById("toolCount"), toolsListEl=document.getElementById("toolsList");
const logEl=document.getElementById("log");
const toastEl=document.getElementById("toast");

let lastLogCount=0;
const MAX_LOG=50;
let lastToolsJson="";

function toast(msg, isErr){
  toastEl.textContent=msg;
  toastEl.className="toast show"+(isErr?" err":"");
  clearTimeout(toast._t);
  toast._t=setTimeout(()=>{ toastEl.className="toast"; },1800);
}

function pushLog(level, text){
  const ts=new Date().toTimeString().slice(0,8);
  const div=document.createElement("div");
  div.className="e"+(level==="error"?" err":level==="ok"?" ok":"");
  div.innerHTML=`<span class="t">${ts}</span>${escapeHtml(text)}`;
  logEl.appendChild(div);
  while(logEl.children.length>MAX_LOG) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop=logEl.scrollHeight;
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);}

chrome.storage.local.get(["bridgeUrl","mcpUrl"], v=>{
  if(v.bridgeUrl) bridgeEl.textContent=v.bridgeUrl;
  if(v.mcpUrl) mcpEl.textContent=v.mcpUrl;
});
chrome.runtime.sendMessage({type:"version"}, r=>{ if(r&&r.version) verEl.textContent="v"+r.version; });

chrome.runtime.onMessage.addListener((msg)=>{
  if(msg && msg.type==="log"){
    pushLog(msg.level||"info", msg.text||"");
  }
});

function fmtU(s){ if(!s&&s!==0) return "-"; const h=Math.floor(s/3600),m=Math.floor(s%3600/60),sec=s%60; return (h?h+"h ":"")+m+"m "+sec+"s"; }
function setStatus(s,detail){
  dot.classList.remove("green","yellow","red");
  if(s==="ready"){ dot.classList.add("green"); txt.textContent="ready"; }
  else if(s==="bridge"){ dot.classList.add("yellow"); txt.textContent="bridge only"; }
  else { txt.textContent="offline"; }
  if(detail){
    if(typeof detail.uptime==="number") upEl.textContent=fmtU(detail.uptime);
    if(Array.isArray(detail.servers)) serversEl.textContent=detail.servers.length?detail.servers.join(", "):"-";
  }
}

async function loadTools(){
  try{
    const r=await fetch("http://127.0.0.1:17613/tools",{cache:"no-store"});
    if(r.ok){
      const j=await r.json();
      const arr=(j&&j.tools)?j.tools:[];
      toolCountEl.textContent=arr.length+" available";
      const sig=JSON.stringify(arr.map(t=>t.name).sort());
      if(sig!==lastToolsJson){
        lastToolsJson=sig;
        toolsListEl.innerHTML=arr.map(t=>`<span class="t">${escapeHtml(t.name)}</span>`).join("")||'<span class="t" style="color:var(--muted)">none</span>';
      }
      return arr.length;
    }
  }catch{}
  toolCountEl.textContent="-";
  toolsListEl.innerHTML='<span class="t" style="color:var(--muted)">bridge offline</span>';
  return 0;
}

async function check(){
  let got=false;
  try{
    const r=await fetch("http://127.0.0.1:3001/health",{cache:"no-store"});
    if(r.ok){ const j=await r.json().catch(()=>({})); setStatus("ready",j); got=true; await loadTools(); }
  }catch{}
  if(!got){
    try{
      const r=await fetch("http://127.0.0.1:17613/health",{cache:"no-store"});
      if(r.ok){ const j=await r.json().catch(()=>({})); setStatus("bridge",j); await loadTools(); got=true; }
    }catch{}
  }
  if(!got){ setStatus("offline"); await loadTools(); }
}
check(); setInterval(check,2000);

document.getElementById("startAgent").onclick=async()=>{
  const btn=document.getElementById("startAgent");
  btn.disabled=true; btn.textContent="⏳ Starting…";
  try{
    const r=await chrome.runtime.sendMessage({type:"start_agent"});
    if(r && r.ok){ toast("Agent started in AI tab"); pushLog("ok","Started agent in "+r.url); }
    else{ toast(r&&r.error?r.error:"No AI tab open"); pushLog("error", r&&r.error?r.error:"No AI tab open"); }
  }catch(e){ toast(String(e),true); }
  setTimeout(()=>{ btn.disabled=false; btn.textContent="▶ Start agent"; },1500);
};

document.getElementById("reconnect").onclick=()=>{ chrome.runtime.sendMessage({type:"reconnect"}); setTimeout(check,500); toast("Reconnecting…"); };
document.getElementById("restart").onclick=async()=>{
  if(!confirm("Restart the RoLink bridge? Any open sessions will be dropped.")) return;
  try{ await fetch("http://127.0.0.1:17613/health",{method:"POST",cache:"no-store"}); }catch{}
  chrome.runtime.sendMessage({id:"rst",method:"restart"});
  toast("Restarting bridge…"); setTimeout(check,2000);
};
document.getElementById("openStudio").onclick=()=>{ window.open("https://create.roblox.com/dashboard","_blank"); };
document.getElementById("openOptions").onclick=()=>{
  if(chrome.runtime.openOptionsPage){ try{ chrome.runtime.openOptionsPage(()=>{ if(chrome.runtime.lastError) window.open(chrome.runtime.getURL("options.html")); }); return; }catch{} }
  window.open(chrome.runtime.getURL("options.html"));
};
