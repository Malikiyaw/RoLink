async function checkHealth(){
  const bridgeEl = document.getElementById("bridgeStatus");
  const mcpEl = document.getElementById("mcpStatus");
  try{ const r=await fetch("http://127.0.0.1:17613/health"); const j=await r.json(); bridgeEl.textContent = j.ok?`OK clients=${j.wsClients}`:"down"; bridgeEl.style.color=j.ok?"green":"red"; }catch{ bridgeEl.textContent="down"; bridgeEl.style.color="red"; }
  try{ const r=await fetch("http://127.0.0.1:3001/health"); const j=await r.json(); mcpEl.textContent=j.ok?`OK q=${j.queueDepth}`:"down"; mcpEl.style.color=j.ok?"green":"red"; }catch{ mcpEl.textContent="down"; mcpEl.style.color="red"; }
}
checkHealth(); setInterval(checkHealth,3000);

const logEl=document.getElementById("log");
function log(m){ logEl.textContent+=`[${new Date().toLocaleTimeString()}] ${m}\n`; logEl.scrollTop=logEl.scrollHeight; }

// learn toggle
const toggle=document.getElementById("learnToggle");
chrome.storage.local.get(["learnMode"],(v)=>{ if(v.learnMode) toggle.classList.add("on"); });
toggle.onclick=()=>{
  toggle.classList.toggle("on");
  const on=toggle.classList.contains("on");
  chrome.storage.local.set({learnMode:on});
  log(`Learn mode ${on?"ON":"OFF"}`);
  chrome.runtime.sendMessage({type:"rolink:enqueue",payload:{tool:"learning_mode",command:"--learn",args:{enabled:on}}});
};

document.getElementById("applyDiff").onclick=async()=>{
  const sel=document.getElementById("difficulty").value;
  try{ const r=await fetch("http://127.0.0.1:3001/dda/profile",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({profile:sel})}); const j=await r.json(); log(`difficulty ${sel}: ${JSON.stringify(j)}`);}catch(e){log("diff error "+e)}
};

document.getElementById("genSound").onclick=async()=>{
  const prompt=document.getElementById("soundPrompt").value||"explosion";
  try{ const r=await fetch("http://127.0.0.1:3001/sound/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt, type:"sfx"})}); const j=await r.json(); log(`sound ${prompt}: ${JSON.stringify(j)}`);}catch(e){log("sound error "+e)}
};

document.getElementById("enqueueTest").onclick=async()=>{
  const payload={tool:"create_instance",command:'Instance.new("Part")',args:{className:"Part",parent:"workspace",name:"RoLinkTest",properties:{Anchored:true}}};
  try{
    const res=await chrome.runtime.sendMessage({type:"rolink:enqueue",payload});
    log("enqueue "+JSON.stringify(res).slice(0,300));
  }catch(e){ log("enqueue fail "+e+" (try http fallback)"); try{ const r=await fetch("http://127.0.0.1:3001/queue/enqueue",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}); log("http "+await r.text()); }catch(e2){log("http fail "+e2)}}
};

document.getElementById("openOptions").onclick=()=> chrome.runtime.openOptionsPage?.();
