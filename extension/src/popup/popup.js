const $ = id=>document.getElementById(id);
const logEl=$("log"), reviewOut=$("reviewOut"), tplPreview=$("templatePreview");
function log(m){ logEl.textContent+=`[${new Date().toLocaleTimeString()}] ${m}\n`; logEl.scrollTop=logEl.scrollHeight; }
function rlog(m){ reviewOut.textContent=m; }
function tpl(m){ tplPreview.textContent=m; }

// tabs
document.querySelectorAll(".tab").forEach(t=> t.onclick=()=>{
  document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
  document.querySelectorAll(".section").forEach(x=>x.classList.remove("active"));
  t.classList.add("active"); $(t.dataset.tab).classList.add("active");
});

async function checkHealth(){
  const b=$("bridgeStatus"), m=$("mcpStatus"), perf=$("perfBadge");
  try{ const r=await fetch("http://127.0.0.1:17613/health"); const j=await r.json(); b.textContent=j.ok?`OK ${j.wsClients}c`:"down"; b.style.color=j.ok?"green":"red"; }catch{ b.textContent="down"; b.style.color="red"; }
  try{ const r=await fetch("http://127.0.0.1:3001/health"); const j=await r.json(); m.textContent=j.ok?`OK q=${j.queueDepth} tools=${j.tools}`:"down"; m.style.color=j.ok?"green":"red"; }catch{ m.textContent="down"; m.style.color="red"; }
  try{ const r=await fetch("http://127.0.0.1:3001/perf"); const j=await r.json(); perf.textContent=`avg ${j.stats.avgMs||0}ms p95 ${j.stats.p95Ms||0}ms`; $("queueDepth").textContent=`depth ${j.stats?.count||0}`; }catch{}
}
checkHealth(); setInterval(checkHealth,3000);

// learn toggle
const toggle=$("learnToggle");
chrome.storage.local.get(["learnMode"],v=>{ if(v.learnMode) toggle.classList.add("on"); });
toggle.onclick=()=>{
  toggle.classList.toggle("on");
  const on=toggle.classList.contains("on");
  chrome.storage.local.set({learnMode:on});
  log(`Learn mode ${on?"ON":"OFF"}`);
  chrome.runtime.sendMessage({type:"rolink:enqueue",payload:{tool:"learning_mode",command:"--learn",args:{enabled:on}}}).catch(()=>{});
};

$("applyDiff").onclick=async()=>{
  const sel=$("difficulty").value;
  try{ const r=await fetch("http://127.0.0.1:3001/dda/profile",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({profile:sel})}); const j=await r.json(); log(`difficulty ${sel}: ${JSON.stringify(j)}`);}catch(e){log("diff error "+e)}
};

$("genSound").onclick=async()=>{
  const prompt=$("soundPrompt").value||"explosion";
  try{ const r=await fetch("http://127.0.0.1:3001/sound/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt, type:"sfx"})}); const j=await r.json(); log(`sound ${prompt}: ${JSON.stringify(j)}`);}catch(e){log("sound error "+e)}
};

async function enqueue(payload){
  try{ const res=await chrome.runtime.sendMessage({type:"rolink:enqueue",payload}); log("enqueue "+JSON.stringify(res).slice(0,400)); return res; }
  catch(e){ log("enqueue fail "+e); try{ const r=await fetch("http://127.0.0.1:3001/queue/enqueue",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}); const j=await r.json(); log("http "+JSON.stringify(j).slice(0,300)); }catch(e2){log("http fail "+e2)} }
}

$("enqueueTest").onclick=()=> enqueue({tool:"create_instance",command:'Instance.new("Part")',args:{className:"Part",parent:"workspace",name:"RoLinkTest",properties:{Anchored:true}}});
$("snapshotBtn").onclick=()=> enqueue({tool:"get_snapshot",command:"--snapshot",args:{maxDepth:2}});
$("undoBtn").onclick=()=> enqueue({tool:"undo",command:"--undo",args:{steps:1}});
$("rollbackBtn").onclick=async()=>{ try{ const r=await fetch("http://127.0.0.1:3001/rollback",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({projectId:"default",steps:1})}); log("rollback "+await r.text()); }catch(e){log("rollback err "+e)} };

$("planBtn").onclick=async()=>{
  try{ const r=await fetch("http://127.0.0.1:3001/plan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:"make an obby with 3 stages"})}); const j=await r.json(); log("plan "+JSON.stringify(j.plan,null,2).slice(0,800)); }catch(e){log("plan err "+e)}
}
$("validateBtn").onclick=async()=>{
  const code=$("codePatch").value||$("reviewCode").value||'local x=Instance.new("Part")';
  try{ const r=await fetch("http://127.0.0.1:3001/tools/call",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"validate_code",arguments:{code}})}); rlog(await r.text()); }catch(e){rlog("err "+e)}
}

// logs
$("refreshLogs").onclick=async()=>{
  try{ const r=await fetch("http://127.0.0.1:3001/logs?limit=20"); const j=await r.json(); logEl.textContent=JSON.stringify(j.logs,null,2); }catch(e){log("logs err "+e)}
}
$("clearLogs").onclick=async()=>{ try{ const r=await fetch("http://127.0.0.1:3001/queue/status"); logEl.textContent=await r.text(); }catch(e){log(e)} }

// templates
async function loadTemplates(){
  try{ const r=await fetch("http://127.0.0.1:3001/templates"); const j=await r.json(); const sel=$("templateSel"); sel.innerHTML=""; j.templates.forEach(t=>{ const o=document.createElement("option"); o.value=t.id; o.textContent=`${t.id} — ${t.name}`; sel.appendChild(o); }); if(j.templates[0]) tpl(JSON.stringify(j.templates[0],null,2)); }catch(e){tpl("err "+e)}
}
$("listTemplates").onclick=loadTemplates;
$("templateSel").onchange=e=>{ const id=e.target.value; fetch("http://127.0.0.1:3001/templates").then(r=>r.json()).then(j=>{ const t=j.templates.find(x=>x.id===id); if(t) tpl(JSON.stringify(t,null,2)); }); };
$("useTemplate").onclick=async()=>{
  const id=$("templateSel").value;
  try{ const r=await fetch("http://127.0.0.1:3001/templates/use",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})}); const j=await r.json(); log(`use_template ${id}: ${JSON.stringify(j).slice(0,400)}`);}catch(e){log("use err "+e)}
}
loadTemplates();

// review
$("reviewBtn").onclick=async()=>{
  const code=$("reviewCode").value;
  if(!code) return rlog("paste code first");
  try{ const r=await fetch("http://127.0.0.1:3001/review",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code})}); rlog(JSON.stringify(await r.json(),null,2)); }catch(e){rlog("err "+e)}
}
$("genTestBtn").onclick=async()=>{
  const code=$("reviewCode").value||$("codePatch").value;
  try{ const r=await fetch("http://127.0.0.1:3001/tools/call",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"generate_tests",arguments:{code}})}); rlog(await r.text()); }catch(e){rlog("err "+e)}
}
$("styleBtn").onclick=async()=>{ try{ const r=await fetch("http://127.0.0.1:3001/style?projectId=default"); rlog(await r.text()); }catch(e){rlog("err "+e)} }
