// SPDX-License-Identifier: GPL-3.0-or-later
const KOFI_URL = "https://ko-fi.com/malikiyaw";
const SUPPORTED_HOSTS = [
  "chat.deepseek.com","deepseek.com","chatgpt.com","chat.openai.com",
  "gemini.google.com","www.kimi.ai","kimi.ai",
  "chat.z.ai","chat.qwen.ai","arena.ai","www.meta.ai","meta.ai",
];
const DEFAULT_AI_URL = "https://chat.deepseek.com/";

document.getElementById("ver").textContent = `v${chrome.runtime.getManifest().version}`;

const dotEl=document.getElementById("dot"), stateEl=document.getElementById("state"), toolsEl=document.getElementById("tools");
const toolsListEl=document.getElementById("toolsList"), logEl=document.getElementById("log"), toastEl=document.getElementById("toast");

let lastToolsJson="";
let lastStatus=null;

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
  logEl.style.display="block";
  logEl.appendChild(div);
  while(logEl.children.length>40) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop=logEl.scrollHeight;
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);}

function render(s){
  lastStatus=s;
  const connected = !!(s && s.connected);
  const tools = s && Array.isArray(s.tools) ? s.tools : [];
  const toolsCount = typeof s?.tools==="number" ? s.tools : tools.length;
  const mcpOk = !!(s && s.mcpAlive);
  const studio = s?.studio;
  const studioApp = s?.studioApp;
  let cls = "dot " + (connected ? (mcpOk && studio===true ? "on" : "warn") : "err");
  if(!connected) cls = "dot";
  dotEl.className = cls;
  if(!connected){ stateEl.textContent="Bridge offline"; toolsEl.textContent="Run start.bat"; return; }
  if(studio===true && mcpOk){ stateEl.textContent="Connected · Roblox Studio ready"; }
  else if(mcpOk && studio===false){ stateEl.textContent="Studio not connected · enable MCP in Studio"; }
  else if(studioApp===false){ stateEl.textContent="Bridge OK · open Roblox Studio"; }
  else { stateEl.textContent="Bridge OK · waiting for Studio"; }
  toolsEl.textContent = (toolsCount||0)+" tools available";
  const sig = JSON.stringify(tools.map(t=>t.name||t).sort());
  if(sig && sig!==lastToolsJson){
    lastToolsJson=sig;
    if(tools.length){
      toolsListEl.style.display="block";
      toolsListEl.innerHTML = tools.map(t=>`<span class="t">${escapeHtml(t.name||t)}</span>`).join("");
    } else { toolsListEl.style.display="none"; }
  }
}

function refresh(){
  chrome.runtime.sendMessage({type:"status"}, (s)=> s && render(s));
  chrome.runtime.sendMessage({type:"list_tools"}, (r)=>{
    if(r && Array.isArray(r.tools)){
      render({...lastStatus, tools:r.tools, mcpAlive:true});
    }
  });
}

document.getElementById("startAgent").addEventListener("click", async ()=>{
  const btn=document.getElementById("startAgent");
  btn.disabled=true; btn.textContent="⏳ Starting…";
  try{
    const tabs=await chrome.tabs.query({});
    const active=tabs.find(t=>t.active && t.url && SUPPORTED_HOSTS.some(h=>t.url.includes(h)));
    const any=active || tabs.find(t=>t.url && SUPPORTED_HOSTS.some(h=>t.url.includes(h)));
    if(!any){ toast("Open chat.deepseek.com or another AI tab first",true); pushLog("error","No AI tab open"); }
    else{
      try{
        await chrome.scripting.executeScript({target:{tabId:any.id, allFrames:false}, files:["core/inject.js"]});
        toast("Agent started in "+new URL(any.url).hostname);
        pushLog("ok","Started agent in "+any.url);
        chrome.tabs.update(any.id,{active:true});
      }catch(e){ toast(String(e),true); pushLog("error",String(e)); }
    }
  }catch(e){ toast(String(e),true); }
  setTimeout(()=>{ btn.disabled=false; btn.textContent="▶ Start agent"; },1500);
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
document.getElementById("settings").addEventListener("click", ()=>{
  chrome.tabs.query({}, (tabs)=>{
    const active=tabs.find(t=>t.active && t.url && SUPPORTED_HOSTS.some(h=>t.url.includes(h)));
    const any=active || tabs.find(t=>t.url && SUPPORTED_HOSTS.some(h=>t.url.includes(h)));
    if(any){
      chrome.tabs.sendMessage(any.id,{type:"rolink-open-menu"}).catch(()=>{});
      chrome.tabs.update(any.id,{active:true});
    } else {
      chrome.tabs.create({url:"options.html"});
    }
  });
});

chrome.runtime.onMessage.addListener((msg)=>{
  if(msg && msg.type==="status") render(msg);
  if(msg && msg.type==="log") pushLog(msg.level||"info", msg.text||"");
});
refresh();
setInterval(refresh, 2000);
