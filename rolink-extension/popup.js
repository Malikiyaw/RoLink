// SPDX-License-Identifier: GPL-3.0-or-later
const SUPPORTED_HOSTS = [
  "chat.deepseek.com","deepseek.com","chatgpt.com","chat.openai.com",
  "gemini.google.com","www.kimi.ai","kimi.ai",
  "chat.z.ai","chat.qwen.ai","arena.ai","www.meta.ai","meta.ai",
];
const DEFAULT_AI_URL = "https://chat.deepseek.com/";

document.getElementById("ver").textContent = `v${chrome.runtime.getManifest().version}`;

const dotEl=document.getElementById("dot"), stateEl=document.getElementById("state"), toolsEl=document.getElementById("tools");
const toolsListEl=document.getElementById("toolsList"), toastEl=document.getElementById("toast");
let lastStatus=null, lastToolsJson="";

function toast(msg, isErr){
  toastEl.textContent=msg;
  toastEl.className="toast show"+(isErr?" err":"");
  clearTimeout(toast._t);
  toast._t=setTimeout(()=>{ toastEl.className="toast"; },1800);
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);}

function render(s){
  lastStatus=s;
  const connected=!!(s&&s.connected);
  const mcpOk=!!(s&&s.mcpAlive);
  const studio=s?.studio;
  let cls="dot "+(connected?(mcpOk&&studio===true?"on":"warn"):"err");
  if(!connected) cls="dot";
  dotEl.className=cls;
  if(!connected){ stateEl.textContent="Bridge offline"; toolsEl.textContent="Run start.bat"; return; }
  if(studio===true && mcpOk){ stateEl.textContent="Connected · Roblox Studio ready"; }
  else if(mcpOk && studio===false){ stateEl.textContent="Enable MCP in Roblox Studio"; }
  else { stateEl.textContent="Bridge OK · open Roblox Studio"; }
  const tools=Array.isArray(s?.tools)?s.tools:[];
  const n=typeof s?.tools==="number"?s.tools:tools.length;
  toolsEl.textContent=(n||0)+" tools available";
  const sig=JSON.stringify(tools.map(t=>t.name||t).sort());
  if(sig && sig!==lastToolsJson){
    lastToolsJson=sig;
    if(tools.length){
      toolsListEl.style.display="block";
      toolsListEl.innerHTML=tools.map(t=>`<span class="t">${escapeHtml(t.name||t)}</span>`).join("");
    } else { toolsListEl.style.display="none"; }
  }
}

function refresh(){
  chrome.runtime.sendMessage({type:"status"}, s=>s&&render(s));
  chrome.runtime.sendMessage({type:"list_tools"}, r=>{
    if(r && Array.isArray(r.tools)) render({...lastStatus, tools:r.tools, mcpAlive:true});
  });
}

document.getElementById("startAgent").addEventListener("click", async ()=>{
  const btn=document.getElementById("startAgent");
  btn.disabled=true; btn.innerHTML='<span class="ic">⏳</span> Starting…';
  try{
    const tabs=await chrome.tabs.query({});
    const active=tabs.find(t=>t.active && t.url && SUPPORTED_HOSTS.some(h=>t.url.includes(h)));
    const any=active || tabs.find(t=>t.url && SUPPORTED_HOSTS.some(h=>t.url.includes(h)));
    if(!any){
      toast("Open chat.deepseek.com or another AI tab first", true);
      chrome.tabs.create({url:DEFAULT_AI_URL});
    } else {
      chrome.tabs.update(any.id,{active:true});
      // Tell the in-page launcher to start (one message, one response)
      try{
        const resp = await chrome.tabs.sendMessage(any.id,{type:"rolink-start"});
        toast(resp && resp.ok ? "Agent started in "+new URL(any.url).hostname : "Agent starting…");
      }catch{
        // Content script might not be loaded yet — click the page button as fallback
        try{ await chrome.scripting.executeScript({target:{tabId:any.id,allFrames:false},func:()=>{ const b=document.querySelector("#rl-root .rl-launcher"); if(b) b.click(); }}); toast("Started (fallback)"); }catch{}
      }
    }
  }catch(e){ toast(String(e),true); }
  setTimeout(()=>{ btn.disabled=false; btn.innerHTML='<span class="ic">R</span> Start RoLink agent'; },1500);
});
document.getElementById("reconnect").addEventListener("click", ()=>{
  chrome.runtime.sendMessage({type:"reconnect"}, ()=> setTimeout(refresh, 600));
});
document.getElementById("restart").addEventListener("click", (e)=>{
  e.target.textContent="Restarting…";
  chrome.runtime.sendMessage({type:"restart_mcp"}, ()=>{
    e.target.textContent="⟲ Restart Roblox server";
    setTimeout(refresh, 1500);
  });
});

chrome.runtime.onMessage.addListener(msg=>{
  if(msg && msg.type==="rolink-status") render(msg);
});
refresh();
setInterval(refresh, 2000);
