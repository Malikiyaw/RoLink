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
const healthMcpEl=document.getElementById("h-mcp-val"), healthStudioEl=document.getElementById("h-studio-val"), healthPortEl=document.getElementById("h-port-val"), healthUptimeEl=document.getElementById("h-uptime-val");
const logsListEl=document.getElementById("logsList");
let lastStatus=null, lastToolsJson="", allTools=[], startTime=Date.now();

// Category map for 111 tools
const CATEGORY_MAP = {
  "Core Manipulation":["get_instances","create_instance","set_properties","delete_instance","clone_instance","move_instance","find_instance"],
  "Scripting":["execute_luau","get_script_content","set_script_content","create_module","run_function","add_event_handler","remove_event_handler","get_global_variables"],
  "Snapshots":["take_snapshot","rollback","diff_snapshots"],
  "Sandbox":["run_in_sandbox","confirm_sandbox_apply","discard_sandbox","simulate_ticks"],
  "Context":["get_context_summary","get_function_signatures","get_property_value","get_all_properties","search_by_attribute","get_referenced_instances"],
  "Dependency":["resolve_path","ensure_path","get_dependency_graph","suggest_ordering","validate_command"],
  "Perf":["get_performance_stats","analyze_performance","set_performance_threshold","get_memory_usage"],
  "Terrain":["generate_terrain","set_terrain_region","place_parts","create_model_from_table","apply_material"],
  "GUI":["create_ui","set_ui_property","get_ui_tree","bind_ui_click"],
  "Animation":["create_animation_track","play_animation","set_lighting","add_particle_emitter"],
  "DataStore":["setup_datastore","get_datastore_value","set_datastore_value"],
  "Team":["export_session_log","replay_session","list_sessions","compare_sessions"],
  "Templates":["list_templates","apply_template","add_template"],
  "Misc":["get_time","send_notification","batch_queue","cancel_command"],
  "Train":["train_model"],
  "Visual":["compile_visual_graph"],
  "Test":["generate_test","run_tests"],
  "Collab":["session_users"],
  "Assets":["search_asset","import_asset"],
  "Metrics":["report_metrics","get_metrics"],
  "Git":["git_commit","git_log","git_rollback"],
  "Predict":["predict_bug"],
  "Game":["plan_game","execute_plan"],
  "Review":["review_code","refactor_code"],
  "Gen":["generate_asset"],
  "PerfOpt":["optimize_performance"],
  "Analytics":["report_analytics","get_analytics","suggest_design"],
  "Plugins":["list_plugins","load_plugin"],
  "Debug":["set_breakpoint","remove_breakpoint","watch_variable","step_through","continue_execution"],
  "Level":["generate_level"],
  "Projects":["get_projects","switch_project","create_project"],
  "Suggest":["get_suggestions"],
  "Playtest":["run_playtest"],
  "Archive":["export_project","import_project"],
  "Quest":["generate_quest"],
  "Economy":["simulate_economy","suggest_balance"],
  "Explain":["explain_code","learning_mode"],
  "DDA":["adjust_difficulty","set_difficulty_profile"],
  "Sound":["generate_sound","generate_sound_pack","play_sound"],
};
const CATEGORY_ORDER = Object.keys(CATEGORY_MAP);
const REVERSE_MAP = {};
for(const [cat, arr] of Object.entries(CATEGORY_MAP)){ for(const n of arr) REVERSE_MAP[n]=cat; }

function toast(msg, isErr){
  toastEl.textContent=msg;
  toastEl.className="toast show"+(isErr?" err":"");
  clearTimeout(toast._t);
  toast._t=setTimeout(()=>{ toastEl.className="toast"; },1800);
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);}
// Sprint C: "last used" stamps read as relative time ("just now", "3m ago").
function relTime(ts){
  try{
    const d=(Date.now()-Number(ts))/1000;
    if(!isFinite(d)||d<0) return "";
    if(d<45) return "just now";
    if(d<3600) return Math.floor(d/60)+"m ago";
    if(d<86400) return Math.floor(d/3600)+"h ago";
    if(d<86400*30) return Math.floor(d/86400)+"d ago";
    return new Date(Number(ts)).toLocaleDateString();
  }catch{ return ""; }
}

function render(s){
  lastStatus=s;
  const connected=!!(s&&s.connected);
  const mcpOk=!!(s&&s.mcpAlive);
  const studio=s?.studio;
  let cls="dot "+(connected?(mcpOk&&studio===true?"on":"warn"):"err");
  if(!connected) cls="dot";
  dotEl.className=cls;
  if(!connected){ stateEl.textContent="Bridge offline"; toolsEl.textContent="Run start.bat"; }
  else if(studio===true && mcpOk){ stateEl.textContent="Connected · Roblox Studio ready"; }
  else if(mcpOk && studio===false){ stateEl.textContent="Enable MCP in Roblox Studio"; }
  else { stateEl.textContent="Bridge OK · open Roblox Studio"; }
  const tools=Array.isArray(s?.tools)?s.tools:[];
  const n=typeof s?.tools==="number"?s.tools:tools.length;
  toolsEl.textContent=(n||0)+" tools available";
  // health
  if(healthMcpEl) healthMcpEl.textContent = mcpOk ? `● ${n} tools` : "○ offline";
  if(healthStudioEl) healthStudioEl.textContent = studio===true ? "● Ready" : studio===false ? "○ No place" : "○ Unknown";
  if(healthPortEl) healthPortEl.textContent = connected ? "● 17613" : "○ offline";
  if(healthUptimeEl) healthUptimeEl.textContent = Math.floor((Date.now()-startTime)/1000)+"s";
  const mcpCard=document.getElementById("h-mcp"); if(mcpCard) mcpCard.className="health-card "+(mcpOk?"ok":"err");
  const studioCard=document.getElementById("h-studio"); if(studioCard) studioCard.className="health-card "+(studio===true?"ok":studio===false?"warn":"err");
  renderMcpServers(s);
  allTools = tools;
  renderTools(tools);
  applyLive();
}

// Per-server dots, scoped per server. The header dot above only reflects
// bridge+Roblox aggregate (any_alive + studio), so an addon outage here
// never reddens the Roblox row or the main dot.
function renderMcpServers(s){
  const mv = document.getElementById("mcp-servers-val");
  const ml = document.getElementById("mcp-servers-list");
  if(!mv) return;
  const list = s?.mcp_servers || lastStatus?.mcp_servers || [];
  const active = list.filter(x => x && x.alive !== false).length;
  mv.textContent = list.length ? `● ${active}/${list.length} active` : "○ none";
  mv.style.color = list.length ? "var(--text)" : "var(--muted)";
  if(ml){
    ml.innerHTML = list.map(x=>{
      const id = escapeHtml(x.id || x.server_id || "?");
      const on = x && x.alive !== false;
      const n = (x && typeof x.tools === "number") ? `<span class="mcp-tools">· ${x.tools} tools</span>` : "";
      return `<div class="mcp-srv ${(id==="roblox")?"roblox":"addon"} ${on?"on":"off"}"><span class="mcp-dot">${on?"●":"○"}</span><span>${id}</span>${n}</div>`;
    }).join("");
  }
}

// Sprint B: popup live highlight — pulse the running tool chip and stamp
// per-tool "last used" times. Runs after every render/broadcast regardless
// of whether renderTools' signature cache short-circuited a full repaint.
function applyLive(){
  try{
    const agent=(lastStatus && lastStatus.agent)||null;
    const run=(agent && agent.running && agent.running.name)||"";
    const lastUsed=(agent && agent.lastUsed)||{};
    toolsListEl.querySelectorAll(".tool-chip").forEach(ch=>{
      const nm=ch.dataset.tool||"";
      ch.classList.toggle("live", !!run && nm===run);
      const ts=lastUsed[nm];
      if(ts){
        const rel=relTime(ts);
        // Re-stamp only when the relative label changes (each minute/hour),
        // so tooltips stay fresh without rewriting them every 2s refresh.
        if(ch.dataset.lur !== rel){
          ch.dataset.lur=rel;
          const base=ch.title ? ch.title.split(" — last used")[0] : nm;
          ch.title=base+" — last used "+rel;
        }
      }
    });
    const hintEl=document.getElementById("toolsHint");
    if(hintEl){
      const base=hintEl.dataset.base || hintEl.textContent;
      hintEl.dataset.base=base;
      hintEl.innerHTML=run
        ? `${base} — <span style="color:#a371f7">⚡ using <b>${escapeHtml(run)}</b></span>`
        : base;
    }
  }catch{}
}

function renderTools(tools){
  const filter=(document.getElementById("toolSearch")?.value||"").toLowerCase().trim();
  const sig=JSON.stringify(tools.map(t=>t.name||t).sort())+filter;
  if(sig===lastToolsJson && toolsListEl.dataset.filter===filter) return;
  lastToolsJson=sig;
  toolsListEl.dataset.filter=filter;
  if(!tools.length){
    toolsListEl.innerHTML='<span style="color:var(--muted)">No tools — start bridge + Studio</span>';
    return;
  }
  // group
  const groups={};
  let powerCount=0;
  for(const t of tools){
    const name=t.name||t;
    const cat=REVERSE_MAP[name]||"Other";
    if(!groups[cat]) groups[cat]=[];
    groups[cat].push({name, raw:t});
    if(/^(self_heal|rollback|generate_test|review_code|generate_asset|train_model|optimize_performance|generate_sound|adjust_difficulty|explain_code|simulate_economy|suggest_design|compile_visual_graph|generate_level|generate_quest|export_project|get_analytics|git_rollback|playtest|run_playtest|get_performance_stats|analyze_performance)/.test(name)) powerCount++;
  }
  const hintEl=document.getElementById("toolsHint");
  if(hintEl) hintEl.innerHTML = `${tools.length} tools grouped by category — <span style="color:#a371f7">${powerCount} power tools</span> active`;
  const connectedSet=new Set(tools.map(t=>t.name||t));
  let html="";
  for(const cat of CATEGORY_ORDER){
    let arr=groups[cat]; if(!arr||!arr.length) continue;
    if(filter) arr=arr.filter(x=> x.name.toLowerCase().includes(filter) || cat.toLowerCase().includes(filter));
    if(!arr.length) continue;
    const collapsed = filter ? "" : "";
    html += `<div class="cat-header" data-cat="${cat}"><span class="arrow">▼</span> ${cat} <span class="count">${arr.length}</span></div>`;
    html += `<div class="tools-grid" data-grid="${cat}">`;
    for(const x of arr){
      const isConnected=connectedSet.has(x.name);
      const isPower = /^(self_heal|rollback|generate_test|review_code|generate_asset|train_model|optimize_performance|generate_sound|adjust_difficulty|explain_code|simulate_economy|suggest_design|compile_visual_graph|generate_level|generate_quest|export_project|get_analytics|git_rollback|playtest|run_playtest|get_performance_stats|analyze_performance)/.test(x.name);
      // Sprint A: persona first line leads the tooltip (persona-lines.js); description follows.
      let tip = `${x.name} — ${x.raw.description||''}`;
      try{
        const pl = (typeof window !== "undefined" && window.ROLINK_PERSONA_LINES) || null;
        const line = pl && pl[x.name];
        if(line) tip = `${line} — ${x.raw.description||x.name}`;
      }catch{}
      html += `<span class="tool-chip ${isConnected?'connected':''} ${isPower?'power':''}" title="${escapeHtml(tip)}" data-tool="${escapeHtml(x.name)}">${escapeHtml(x.name)}</span>`;
    }
    html += `</div>`;
  }
  // Other uncategorized
  if(groups["Other"]){
    let arr=groups["Other"];
    if(!filter || arr.some(x=> x.name.toLowerCase().includes(filter))){
      if(filter) arr=arr.filter(x=> x.name.toLowerCase().includes(filter));
      if(arr.length){
        html += `<div class="cat-header" data-cat="Other"><span class="arrow">▼</span> Other <span class="count">${arr.length}</span></div><div class="tools-grid" data-grid="Other">`;
        for(const x of arr){
          let tip = x.name;
          try{
            const pl = (typeof window !== "undefined" && window.ROLINK_PERSONA_LINES) || null;
            if(pl && pl[x.name]) tip = pl[x.name];
          }catch{}
          html += `<span class="tool-chip connected" title="${escapeHtml(tip)}" data-tool="${escapeHtml(x.name)}">${escapeHtml(x.name)}</span>`;
        }
        html += `</div>`;
      }
    }
  }
  toolsListEl.innerHTML=html||'<span style="color:var(--muted)">No matches</span>';
  // chip click copy
  toolsListEl.querySelectorAll(".tool-chip").forEach(el=>{
    el.addEventListener("click", ()=>{
      const name=el.dataset.tool;
      navigator.clipboard?.writeText(name).then(()=> toast(`Copied ${name}`));
      el.style.background="rgba(63,185,80,.3)";
      setTimeout(()=> el.style.background="", 400);
    });
  });
  // collapsible
  toolsListEl.querySelectorAll(".cat-header").forEach(h=>{
    h.addEventListener("click", ()=>{
      const cat=h.dataset.cat;
      const grid=toolsListEl.querySelector(`[data-grid="${cat}"]`);
      if(grid){ grid.classList.toggle("collapsed"); h.classList.toggle("collapsed"); }
    });
  });
}

function renderLogs(){
  chrome.runtime.sendMessage({type:"status"}, s=>{
    const logs = s?.logs || [];
    if(!logs.length) logsListEl.innerHTML='<span style="color:var(--muted)">No logs yet — run a tool</span>';
    else logsListEl.innerHTML=logs.slice(-20).reverse().map(l=> `<div class="log-row"><span class="log-ts">${new Date(l.t||Date.now()).toLocaleTimeString().slice(0,8)}</span><span class="log-msg">${escapeHtml(l.msg||l.event||JSON.stringify(l).slice(0,80))}</span></div>`).join("");
    // Nudges
    const ns = s?.nudgeStats || lastStatus?.nudgeStats;
    const nv = document.getElementById("nudge-val");
    if(nv && ns){
      const total = (ns.malformed||0)+(ns.midStringTruncation||0)+(ns.unknownTool||0);
      const rep = ns.repairSuccess||0;
      nv.textContent = `● ${total} nudges · ${rep} repairs`;
      nv.style.color = total>0 ? (total>5?"#fca5a5":"#e3b341") : "var(--green)";
    }
    // MCP servers summary (per-server rows render in renderMcpServers)
    const mv = document.getElementById("mcp-servers-val");
    if(mv){
      const list = s?.mcp_servers || lastStatus?.mcp_servers || [];
      const active = list.filter(x => x && x.alive !== false).length;
      mv.textContent = list.length ? `● ${active}/${list.length} active` : "○ none";
      mv.style.color = list.length ? "var(--text)" : "var(--muted)";
    }
  });
  // fallback: use lastStatus logs if available
  if(lastStatus && Array.isArray(lastStatus.logs)){
    logsListEl.innerHTML=lastStatus.logs.slice(-20).reverse().map(l=> `<div class="log-row"><span class="log-ts">${new Date(l.t||Date.now()).toLocaleTimeString().slice(0,8)}</span><span class="log-msg">${escapeHtml(l.msg||'') }</span></div>`).join("")||logsListEl.innerHTML;
  }
}

async function refresh(){
  // Batched status-tools single message (optimization)
  try{
    const resp = await chrome.runtime.sendMessage({type:"status-tools"});
    if(resp && resp.status){
      // status.tools may be a bare count — prefer the real array when present.
      const tools = Array.isArray(resp.tools) ? resp.tools : resp.status.tools;
      render({...resp.status, tools});
    } else {
      chrome.runtime.sendMessage({type:"status"}, s=> s&&render(s));
      chrome.runtime.sendMessage({type:"list_tools"}, r=>{
        if(r && Array.isArray(r.tools)) render({...lastStatus, tools:r.tools, mcpAlive:true});
      });
    }
  }catch{
    chrome.runtime.sendMessage({type:"status"}, s=> s&&render(s));
  }
  renderLogs();
}

// Tabs
document.querySelectorAll(".tab").forEach(tab=>{
  tab.addEventListener("click", ()=>{
    document.querySelectorAll(".tab").forEach(t=> t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p=> p.classList.remove("active"));
    tab.classList.add("active");
    const id="panel-"+tab.dataset.tab;
    document.getElementById(id)?.classList.add("active");
    if(tab.dataset.tab==="tools") renderTools(allTools);
    if(tab.dataset.tab==="logs") renderLogs();
  });
});
document.getElementById("toolSearch")?.addEventListener("input", ()=> renderTools(allTools));

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
      try{
        const resp = await chrome.tabs.sendMessage(any.id,{type:"rolink-start"});
        toast(resp && resp.ok ? "Agent started in "+new URL(any.url).hostname : "Agent starting…");
      }catch{
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
    e.target.textContent="⟲ Restart MCP";
    setTimeout(refresh, 1500);
  });
});
document.getElementById("toggleMcp")?.addEventListener("click", ()=>{
  toast("Toggle MCP: open Studio → Assistant AI → ... → Manage MCP Servers");
});
document.getElementById("openOptions")?.addEventListener("click", ()=>{
  chrome.runtime.openOptionsPage?.();
});
document.getElementById("copyLogs")?.addEventListener("click", ()=>{
  const txt=logsListEl.innerText;
  navigator.clipboard?.writeText(txt).then(()=> toast("Logs copied"));
});
document.getElementById("clearLogs")?.addEventListener("click", ()=>{
  logsListEl.innerHTML="No logs yet";
  toast("Cleared");
});
document.getElementById("resetNudges")?.addEventListener("click", ()=>{
  chrome.runtime.sendMessage({type:"nudge_reset"}, ()=> { setTimeout(refresh, 200); });
});
document.getElementById("openMcpConfig")?.addEventListener("click", ()=>{
  chrome.runtime.openOptionsPage?.();
});

chrome.runtime.onMessage.addListener(msg=>{
  if(msg && msg.type==="rolink-status") render(msg);
});
refresh();
setInterval(refresh, 2000);
