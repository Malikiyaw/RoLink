// RoLink background.js — single WS owner (avoids mixed-content), broadcasts status to all provider tabs
const BRIDGE="ws://127.0.0.1:17613";
const HTTP_HEALTH="http://127.0.0.1:17613/health";
const VERSION=chrome.runtime.getManifest().version;
const PROVIDER_URLS=["chat.deepseek.com","chatgpt.com","gemini.google.com","kimi.ai","chat.z.ai","chat.qwen.ai","arena.ai","meta.ai"];
let ws=null, reconnectDelay=1000, heartbeatTimer=null, staleTimer=null;
let toolsCache=null, studioConnected=false;
let pending=new Map();
let offlineSince=null, badgeSet=false;
let healthFailCount=0;

function setBadge(connected){
  try{
    if(connected){
      offlineSince=null; badgeSet=false;
      chrome.action.setBadgeText({text:""}); chrome.action.setBadgeBackgroundColor({color:"#4caf50"});
    } else {
      if(!offlineSince) offlineSince=Date.now();
      const secs=Math.floor((Date.now()-offlineSince)/1000);
      if(secs>=30 && !badgeSet){
        badgeSet=true;
        chrome.action.setBadgeText({text:"!"}); chrome.action.setBadgeBackgroundColor({color:"#f44336"});
      }
    }
  }catch{}
}

async function healthProbe(){
  try{
    const c=new AbortController(); setTimeout(()=>c.abort(), 800);
    const r=await fetch(HTTP_HEALTH, {cache:"no-store", signal:c.signal});
    if(r.ok) { healthFailCount=0; return true; }
  }catch{}
  healthFailCount++;
  return false;
}

async function connect(){
  // Q2 keep dummy token (no auth) — bridge.py accepts any token. Health probe first to avoid ERR_CONNECTION_REFUSED spam.
  const healthy = await healthProbe();
  if(!healthy){
    if(healthFailCount % 5 === 1) console.warn("[RoLink] bridge offline — run start.bat (health probe failed "+healthFailCount+")");
    setBadge(false);
    schedule();
    return;
  }
  try{ ws=new WebSocket(BRIDGE+"/ws?role=extension&token=dummy"); }catch{ setBadge(false); schedule(); return; }
  ws.onopen=()=>{ reconnectDelay=1000; healthFailCount=0; setBadge(true); heartbeatTimer=setInterval(()=>{ if(ws.readyState===1) ws.send(JSON.stringify({id:"hb",method:"heartbeat"})); resetStale(); },10000); resetStale(); broadcast({type:"bridge", status:"connected"}); };
  ws.onclose=()=>{ clearInterval(heartbeatTimer); clearTimeout(staleTimer); setBadge(false); broadcast({type:"bridge", status:"disconnected"}); schedule(); };
  ws.onerror=()=>{ try{ws.close();}catch{}; setBadge(false); };
  ws.onmessage=(e)=>{
    resetStale();
    try{
      const m=JSON.parse(e.data);
      if(m.id && pending.has(m.id)){ pending.get(m.id)(m); pending.delete(m.id); setTimeout(()=>pending.delete(m.id), 60000); }
      if(m.result && m.result.servers) toolsCache=m.result;
      broadcast({type:"result", data:m});
    }catch{}
  };
}
function resetStale(){ clearTimeout(staleTimer); staleTimer=setTimeout(()=>{ try{ws.close();}catch{} },25000); }
function schedule(){ setTimeout(connect, reconnectDelay); reconnectDelay=Math.min(15000, reconnectDelay*1.7); }
function broadcast(msg){
  const urlFilters = PROVIDER_URLS.map(h => "*://" + h + "/*");
  chrome.tabs.query({ url: urlFilters }, tabs => {
    for (const t of tabs) {
      if (t.id == null) continue;
      const p = chrome.tabs.sendMessage(t.id, msg);
      if (p && p.catch) p.catch(() => {});
    }
  });
  if (chrome.runtime.lastError) void chrome.runtime.lastError;
}

// Ensure single alarm (avoid duplicate on SW restart)
chrome.alarms.get("rolink-heartbeat", a => { if(!a) chrome.alarms.create("rolink-heartbeat",{periodInMinutes:0.2}); });

connect();
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg.type==="bridge"){
    sendResponse({ok:true, status: ws && ws.readyState===1 ? "connected" : "disconnected", tools:toolsCache});
    return false;
  }
  if(msg.type==="version"){ sendResponse({version:VERSION}); return false; }
  if(msg.type==="reconnect"){ if(ws){try{ws.close();}catch{}} else { connect(); } sendResponse({ok:true}); return false; }
  if(msg.type==="start_agent"){
    (async()=>{
      const urlFilters = PROVIDER_URLS.map(h => "*://" + h + "/*");
      chrome.tabs.query({ url: urlFilters }, async (tabs)=>{
        if(!tabs.length){ sendResponse({ok:false,error:"No AI tab open. Open chat.deepseek.com, chatgpt.com, etc., then try again."}); return; }
        const tab = tabs.find(t=>t.active) || tabs[0];
        try{
          await chrome.scripting.executeScript({ target:{tabId:tab.id, allFrames:false}, files:["core/inject.js"] });
          sendResponse({ok:true,tabId:tab.id,url:tab.url});
        }catch(e){ sendResponse({ok:false,error:String(e)}); }
      });
    })();
    return true;
  }
  if(msg.type==="inject_done"){
    broadcast({type:"log", level:"info", text:"[agent] started in "+ (msg.provider||"tab")});
    return false;
  }
  if(msg.type==="log"){
    broadcast({type:"log", level:msg.level||"info", text:msg.text||""});
    return false;
  }
  if(msg.id){
    if(ws && ws.readyState===1){
      pending.set(msg.id, (res)=> { try{ sendResponse(res); }catch{} });
      try{ ws.send(JSON.stringify(msg)); }catch(e){ pending.delete(msg.id); sendResponse({error:String(e)}); return false; }
      setTimeout(()=>{ if(pending.has(msg.id)){ pending.delete(msg.id); try{ sendResponse({error:"timeout"});}catch{} } },130000);
      return true;
    } else {
      sendResponse({error:"bridge offline"});
      return false;
    }
  }
});
chrome.alarms.onAlarm.addListener(async ()=>{ if(!ws || ws.readyState!==1) await connect(); else { try{ ws.send(JSON.stringify({id:"hb",method:"heartbeat"})); }catch{} } });

// Keyboard shortcut Ctrl+Shift+R opens the popup (manifest command "open-popup").
chrome.commands?.onCommand?.addListener((cmd)=>{ if(cmd==="open-popup") chrome.action.openPopup?.(); });

