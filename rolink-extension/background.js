// RoLink background.js — single WS owner (avoids mixed-content), broadcasts status to all provider tabs
const BRIDGE="ws://127.0.0.1:17613";
const PROVIDER_URLS=["chat.deepseek.com","chatgpt.com","gemini.google.com","kimi.ai","chat.z.ai","chat.qwen.ai","arena.ai","meta.ai"];
let ws=null, reconnectDelay=1000, heartbeatTimer=null, staleTimer=null;
let toolsCache=null, studioConnected=false;
let pending=new Map();

function connect(){
  try{ ws=new WebSocket(BRIDGE+"/ws?role=extension&token=dummy"); }catch{ schedule(); return; }
  ws.onopen=()=>{ reconnectDelay=1000; heartbeatTimer=setInterval(()=>{ if(ws.readyState===1) ws.send(JSON.stringify({id:"hb",method:"heartbeat"})); resetStale(); },10000); resetStale(); broadcast({type:"bridge", status:"connected"}); };
  ws.onclose=()=>{ clearInterval(heartbeatTimer); clearTimeout(staleTimer); broadcast({type:"bridge", status:"disconnected"}); schedule(); };
  ws.onerror=()=>{ try{ws.close();}catch{} };
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
function schedule(){ setTimeout(connect, reconnectDelay); reconnectDelay=Math.min(5000, reconnectDelay*1.5); }
function broadcast(msg){
  // Only broadcast to provider tabs to avoid "Receiving end does not exist" on unrelated tabs,
  // and swallow Promise rejections (MV3 returns Promise; try/catch does not catch).
  const urlFilters = PROVIDER_URLS.map(h => "*://" + h + "/*");
  chrome.tabs.query({ url: urlFilters }, tabs => {
    for (const t of tabs) {
      if (t.id == null) continue;
      const p = chrome.tabs.sendMessage(t.id, msg);
      if (p && p.catch) p.catch(() => {});
    }
  });
  // Also handle case where query url filter not supported — fallback silent
  if (chrome.runtime.lastError) void chrome.runtime.lastError;
}

connect();
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg.type==="bridge"){
    sendResponse({ok:true, status: ws && ws.readyState===1 ? "connected" : "disconnected", tools:toolsCache});
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
chrome.alarms.create("rolink-heartbeat",{periodInMinutes:0.2});
chrome.alarms.onAlarm.addListener(()=>{ if(!ws || ws.readyState!==1) connect(); else ws.send(JSON.stringify({id:"hb",method:"heartbeat"})); });
