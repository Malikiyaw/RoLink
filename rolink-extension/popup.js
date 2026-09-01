const dot=document.getElementById("dot"), txt=document.getElementById("statustxt");
const bridgeEl=document.getElementById("bridgeUrl"), mcpEl=document.getElementById("mcpUrl");
const clientsEl=document.getElementById("clients"), serversEl=document.getElementById("servers"), upEl=document.getElementById("uptime");
const verEl=document.getElementById("ver");

chrome.storage.local.get(["bridgeUrl","mcpUrl"], v=>{
  if(v.bridgeUrl) bridgeEl.textContent=v.bridgeUrl;
  if(v.mcpUrl) mcpEl.textContent=v.mcpUrl;
});
chrome.runtime.sendMessage({type:"version"}, r=>{ if(r&&r.version) verEl.textContent="v"+r.version; });

function fmtU(s){ if(!s&&s!==0) return "-"; const h=Math.floor(s/3600),m=Math.floor(s%3600/60),sec=s%60; return (h?h+"h ":"")+m+"m "+sec+"s"; }
function setStatus(s,detail){
  dot.classList.remove("green","yellow","red");
  if(s==="ready"){ dot.classList.add("green"); txt.textContent="ready"; }
  else if(s==="bridge"){ dot.classList.add("yellow"); txt.textContent="bridge only"; }
  else if(s==="busy"){ dot.classList.add("red"); txt.textContent="busy"; }
  else { txt.textContent="offline"; }
  if(detail){
    if(typeof detail.clients==="number") clientsEl.textContent=detail.clients;
    if(Array.isArray(detail.servers)) serversEl.textContent=detail.servers.length?detail.servers.join(", "):"-";
    if(typeof detail.uptime==="number") upEl.textContent=fmtU(detail.uptime);
  }
}

async function check(){
  try{
    const r=await fetch("http://127.0.0.1:3001/health",{cache:"no-store"});
    if(r.ok){ const j=await r.json().catch(()=>({})); return setStatus("ready",j); }
  }catch{}
  try{
    const r=await fetch("http://127.0.0.1:17613/health",{cache:"no-store"});
    if(r.ok){ const j=await r.json().catch(()=>({})); return setStatus("bridge",j); }
  }catch{}
  setStatus("offline");
}
check(); setInterval(check,2000);

document.getElementById("reconnect").onclick=()=>{ chrome.runtime.sendMessage({type:"reconnect"}); check(); };
document.getElementById("restart").onclick=async()=>{
  if(!confirm("Restart the RoLink bridge? Any open sessions will be dropped.")) return;
  try{ await fetch("http://127.0.0.1:17613/health",{method:"POST",cache:"no-store"}); }catch{}
  chrome.runtime.sendMessage({id:"rst",method:"restart"});
  setTimeout(check,1500);
};
document.getElementById("openStudio").onclick=()=>{ window.open("https://create.roblox.com/dashboard","_blank"); };
document.getElementById("openOptions").onclick=()=>{
  if(chrome.runtime.openOptionsPage){ try{ chrome.runtime.openOptionsPage(()=>{ if(chrome.runtime.lastError) window.open(chrome.runtime.getURL("options.html")); }); return; }catch{} }
  window.open(chrome.runtime.getURL("options.html"));
};
document.getElementById("copyLogs").onclick=async()=>{
  const text="Windows: %USERPROFILE%\\Desktop\\RoLink-1.1.3\\logs\\start.log\nmacOS: ~/Desktop/RoLink-1.1.3/logs/start.log";
  try{ await navigator.clipboard.writeText(text); document.getElementById("copyLogs").textContent="✓ Copied!"; setTimeout(()=>{document.getElementById("copyLogs").innerHTML='📋 Copy log path';},1500); }catch{}
};
