// RoLink background.js - service worker.
// Owns ONE resilient WebSocket to the local bridge (ws://127.0.0.1:17613).
// Keeping the socket here (not in the content script) avoids https->ws mixed
// content issues and centralises reconnect / timeout logic.
//
// Contract with content.js: every sendMessage ALWAYS gets a response object,
// even when the bridge is offline. The agentic loop must never hang waiting.

const PORT = 17613;
const URL = `ws://127.0.0.1:${PORT}`;

const PROVIDER_URLS = [
  "chat.deepseek.com","deepseek.com","chatgpt.com","chat.openai.com",
  "gemini.google.com","www.kimi.ai","kimi.ai",
  "chat.z.ai","chat.qwen.ai","arena.ai","www.meta.ai","meta.ai"
];

const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 5000;
const HEARTBEAT_MS = 10000;
const STALE_SOCKET_MS = 25000;
const REQUEST_TIMEOUT_DEFAULT = 130000;

let ws = null;
let connected = false;
let reconnectDelay = RECONNECT_MIN;
let reconnectTimer = null;
let heartbeatTimer = null;
let lastMessageAt = 0;
let nextId = 1;
const pending = new Map();
let toolsCache = [];
let mcpAlive = false;
let serversCache = [];
let studioConnected = null;
let studioApp = null;

function log(...a){ console.log("[rolink-bg]", ...a); }

function connect(){
  if(ws && (ws.readyState===WebSocket.OPEN || ws.readyState===WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  try{ ws=new WebSocket(URL); }
  catch(e){ log("WebSocket ctor failed", e); scheduleReconnect(); return; }
  ws.onopen=()=>{
    connected=true; reconnectDelay=RECONNECT_MIN; lastMessageAt=Date.now();
    log("connected to bridge");
    startHeartbeat();
    broadcastStatus();
  };
  ws.onmessage=(ev)=>{
    lastMessageAt=Date.now();
    let msg; try{ msg=JSON.parse(ev.data); }catch{ return; }
    handleBridgeMessage(msg);
  };
  ws.onclose=()=>{
    connected=false; mcpAlive=false; studioConnected=null; studioApp=null; serversCache=[];
    stopHeartbeat(); failAllPending("bridge connection closed"); broadcastStatus(); scheduleReconnect();
  };
  ws.onerror=()=>{ try{ ws.close(); }catch{} };
}
function scheduleReconnect(){
  clearTimeout(reconnectTimer);
  reconnectTimer=setTimeout(connect, reconnectDelay);
  reconnectDelay=Math.min(reconnectDelay*1.7, RECONNECT_MAX);
}
function startHeartbeat(){
  stopHeartbeat();
  heartbeatTimer=setInterval(()=>{
    if(connected){
      if(lastMessageAt && Date.now()-lastMessageAt>STALE_SOCKET_MS){
        log("socket stale, forcing reconnect");
        try{ ws.close(); }catch{}
        return;
      }
      send({type:"ping"}).catch(()=>{});
      refreshStudioStatus();
    }
  }, HEARTBEAT_MS);
}
function stopHeartbeat(){ clearInterval(heartbeatTimer); heartbeatTimer=null; }
function waitForConnection(timeout=8000){
  return new Promise(resolve=>{
    if(connected && ws && ws.readyState===WebSocket.OPEN) return resolve(true);
    connect();
    const t0=Date.now();
    const iv=setInterval(()=>{
      if(connected && ws && ws.readyState===WebSocket.OPEN){ clearInterval(iv); resolve(true); }
      else if(Date.now()-t0>timeout){ clearInterval(iv); resolve(false); }
    }, 100);
  });
}
async function send(obj, timeout=REQUEST_TIMEOUT_DEFAULT){
  if(!connected || !ws || ws.readyState!==WebSocket.OPEN){
    await waitForConnection(8000);
  }
  return new Promise(resolve=>{
    if(!connected || !ws || ws.readyState!==WebSocket.OPEN){
      return resolve({ok:false, kind:"disconnected", error:"bridge not connected"});
    }
    const id=nextId++;
    const payload={...obj, id};
    const timer=setTimeout(()=>{
      if(pending.has(id)){
        pending.delete(id);
        resolve({ok:false, kind:"timeout", error:"bridge did not respond in time"});
      }
    }, timeout);
    pending.set(id, {resolve, timer});
    try{ ws.send(JSON.stringify(payload)); }
    catch(e){
      clearTimeout(timer); pending.delete(id);
      resolve({ok:false, kind:"disconnected", error:String(e)});
    }
  });
}

let studioProbing=false;
async function refreshStudioStatus(){
  if(studioProbing || !connected) return;
  studioProbing=true;
  try{
    const r=await send({type:"studio_status"}, 12000);
    const v=r && r.ok && typeof r.studio==="boolean" ? r.studio : null;
    if(v!==studioConnected){ studioConnected=v; broadcastStatus(); }
  }finally{ studioProbing=false; }
}

function handleBridgeMessage(msg){
  if("studio" in msg && (typeof msg.studio==="boolean" || msg.studio===null)) studioConnected=msg.studio;
  if("studio_app" in msg && (typeof msg.studio_app==="boolean" || msg.studio_app===null)) studioApp=msg.studio_app;
  if(msg.type==="studio_status"){ resolvePending(msg.id, {ok:true, studio:studioConnected}); broadcastStatus(); return; }
  if(msg.type==="connected"){
    mcpAlive=!!msg.mcp_alive;
    if(Array.isArray(msg.tools)) toolsCache=msg.tools;
    if(Array.isArray(msg.servers)) serversCache=msg.servers;
    if(Array.isArray(msg.mcp_servers)) mcpServers = msg.mcp_servers;
    broadcastStatus(); return;
  }
  if(msg.type==="mcp_status"){
    mcpAlive=!!msg.alive;
    if(Array.isArray(msg.tools)) toolsCache=msg.tools;
    if(Array.isArray(msg.servers)) serversCache=msg.servers;
    if(Array.isArray(msg.mcp_servers)) mcpServers = msg.mcp_servers;
    resolvePending(msg.id, {ok:!!msg.ok, alive:msg.alive, error:msg.error});
    broadcastStatus(); return;
  }
  if(msg.type==="pong"){ resolvePending(msg.id, {ok:true}); return; }
  if(msg.type==="tools"){
    if(Array.isArray(msg.tools)) toolsCache=msg.tools;
    if(Array.isArray(msg.servers)) serversCache=msg.servers;
    mcpAlive=!!msg.mcp_alive;
    resolvePending(msg.id, {ok:true, tools:toolsCache});
    broadcastStatus(); return;
  }
  if(msg.type==="tool_result"){
    const kind = msg.kind || (msg.ok ? "success" : "execution_error");
    if(msg.ok === false && !msg.error && msg.text) msg.error = msg.text;
    resolvePending(msg.id, msg.ok
      ? {ok:true, text:msg.text, images:msg.images||[], kind}
      : {ok:false, kind, error:msg.error});
    return;
  }
  if(msg.type==="server_changed"){
    resolvePending(msg.id, {ok:!!msg.ok, error:msg.error, restarting:!!msg.restarting});
    return;
  }
  if(msg.type==="error"){ resolvePending(msg.id, {ok:false, error:msg.error}); return; }
  // Generic id-based dispatch for bridge.py which uses simple {id, result/error}
  if(msg.id!=null && pending.has(msg.id)){
    if(msg.error){ resolvePending(msg.id, {ok:false, error: typeof msg.error==="string" ? msg.error : JSON.stringify(msg.error)}); }
    else if("result" in msg){ resolvePending(msg.id, {ok:true, ...(msg.result||{})}); }
    else { resolvePending(msg.id, msg); }
    return;
  }
  broadcastStatus();
}

function resolvePending(id, value){
  const p=pending.get(id); if(!p) return;
  clearTimeout(p.timer); pending.delete(id); p.resolve(value);
}
function failAllPending(reason){
  for(const [, p] of pending){ clearTimeout(p.timer); p.resolve({ok:false, kind:"disconnected", error:reason}); }
  pending.clear();
}

function deriveBridgeState(){
  if(!connected) return "BRIDGE_OFFLINE";
  if(!mcpAlive) return "MCP_OFFLINE";
  if(studioConnected === false) return "STUDIO_OFFLINE";
  // studioConnected true = place loaded; null = unknown (probe busy) -> treat as MCP_OFFLINE/wait
  if(studioConnected === true) return "STUDIO_READY";
  return "STUDIO_NO_PLACE";
}

// Local nudge counters (independent of the content script's ZSParse counters
// because the background page doesn't load ZSParse). Mirrors what the parser
// reports via the audit-panel API; both surfaces are shown to the user.
const nudgeStats = { malformed: 0, midStringTruncation: 0, unknownTool: 0, repairSuccess: 0 };
function bumpNudge(kind){ if(nudgeStats[kind]==null) nudgeStats[kind]=0; nudgeStats[kind]++; }
function resetNudgeStats(){ for(const k of Object.keys(nudgeStats)) nudgeStats[k]=0; }
function getNudgeStats(){ return { ...nudgeStats }; }

// Multi-MCP server list (per server config) lives on the background page
// because the bridge owns the source of truth. The popup queries it via
// `mcp_servers`.
let mcpServers = [];

function statusObj(){
  return {
    type:"rolink-status",
    connected, mcpAlive, studio:studioConnected, studioApp,
    tools:toolsCache.length,
    servers:serversCache,
    mcp_servers: mcpServers,
    bridgeState: deriveBridgeState(),
    nudgeStats: getNudgeStats(),
    bridgeVersion: chrome.runtime.getManifest().version
  };
}
function broadcastStatus(){
  chrome.runtime.sendMessage(statusObj()).catch(()=>{});
  chrome.tabs.query({url:PROVIDER_URLS.map(h=>"*://"+h+"/*")}, tabs=>{
    for(const t of tabs||[]) chrome.tabs.sendMessage(t.id, statusObj()).catch(()=>{});
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse)=>{
  (async()=>{
    switch(msg.type){
      case "status":
        if(!connected) connect();
        sendResponse(statusObj());
        break;
      case "status-tools": {
        // Batched optimization: single roundtrip for status + tools (Phase 1 quick win)
        if(!connected) connect();
        const s=statusObj();
        const r=await send({type:"list_tools"}, 8000);
        const tools = (r && Array.isArray(r.tools)) ? r.tools : toolsCache;
        sendResponse({ok:true, status:s, tools});
        break;
      }
      case "list_tools": {
        const r=await send({type:"list_tools"}, 10000);
        if(r && r.ok && Array.isArray(r.tools)) sendResponse({ok:true, tools:r.tools});
        else if(r && Array.isArray(r.tools)) sendResponse({ok:true, tools:r.tools});
        else sendResponse({ok:toolsCache.length>0, tools:toolsCache, error:r&&r.error});
        break;
      }
      case "call_tool": {
        // Canonical call_tool protocol: preserve id + session correlation
        const timeout=(msg.timeout||120000)+10000;
        const payload = {type:"call_tool", name:msg.name, arguments:msg.arguments, timeout:msg.timeout};
        if(msg.id) payload.id = msg.id;
        if(msg.sessionId) payload.sessionId = msg.sessionId;
        if(msg.turnId) payload.turnId = msg.turnId;
        // Use caller-provided id if present to keep correlation end-to-end
        let r;
        if(msg.id){
          // Send with caller id directly (don't double-allocate)
          const callerId = msg.id;
          // Temporarily use sendWithId
          r = await (async()=>{
            if(!connected || !ws || ws.readyState!==WebSocket.OPEN) await waitForConnection(8000);
            if(!connected || !ws || ws.readyState!==WebSocket.OPEN) return {ok:false, kind:"disconnected", error:"bridge not connected"};
            return new Promise(resolve=>{
              const timer=setTimeout(()=>{
                if(pending.has(callerId)){ pending.delete(callerId); resolve({ok:false, kind:"timeout", error:"bridge did not respond in time"}); }
              }, timeout);
              pending.set(callerId, {resolve, timer});
              try{ ws.send(JSON.stringify(payload)); }catch(e){ clearTimeout(timer); pending.delete(callerId); resolve({ok:false, kind:"disconnected", error:String(e)}); }
            });
          })();
        } else {
          r = await send(payload, timeout);
        }
        // Ensure kind is always set for callers
        if(r && r.ok===false && !r.kind){
          if(/bridge not connected|disconnected/i.test(r.error||"")) r.kind="bridge_offline";
          else if(/timeout/i.test(r.error||"")) r.kind="timeout";
          else r.kind="execution_error";
        }
        sendResponse(r);
        break;
      }
      case "restart_mcp": {
        const r=await send({type:"restart_mcp"}, 30000);
        sendResponse(r);
        break;
      }
      case "add_server": {
        const r=await send({type:"add_server", server_id:msg.server_id, command:msg.command, args:msg.args, env:msg.env}, 15000);
        sendResponse(r); break;
      }
      case "remove_server": {
        const r=await send({type:"remove_server", server_id:msg.server_id}, 15000);
        sendResponse(r); break;
      }
      case "list_mcp_servers": {
        // Refresh from bridge, then return the cached list (so the UI
        // shows what the bridge actually has, not what it last sent).
        const r=await send({type:"list_tools"}, 10000);
        if(r && Array.isArray(r.servers)) serversCache=r.servers;
        if(r && Array.isArray(r.mcp_servers)) mcpServers=r.mcp_servers;
        sendResponse({ok:true, mcp_servers: mcpServers, servers: serversCache});
        break;
      }
      case "nudge_record": {
        if(msg.kind) bumpNudge(msg.kind);
        sendResponse({ok:true, nudgeStats: getNudgeStats()}); break;
      }
      case "nudge_reset": {
        resetNudgeStats(); sendResponse({ok:true, nudgeStats: getNudgeStats()}); break;
      }
      case "reconnect":
        reconnectDelay=RECONNECT_MIN; connect();
        sendResponse({ok:true}); break;
      case "version":
        sendResponse({version:chrome.runtime.getManifest().version}); break;
      case "session_load": {
        chrome.storage.local.get([msg.key], r => {
          if(chrome.runtime.lastError) sendResponse({ok:false, error:chrome.runtime.lastError.message});
          else sendResponse({ok:true, data: r[msg.key] || null});
        });
        return;
      }
      case "session_save": {
        chrome.storage.local.set({[msg.key]: msg.data}, () => {
          if(chrome.runtime.lastError) sendResponse({ok:false, error:chrome.runtime.lastError.message});
          else sendResponse({ok:true});
        });
        return;
      }
      case "setting_get": {
        chrome.storage.local.get([msg.key], r => {
          if(chrome.runtime.lastError) sendResponse({ok:false, error:chrome.runtime.lastError.message});
          else sendResponse({ok:true, value: r[msg.key]});
        });
        return;
      }
      case "setting_set": {
        chrome.storage.local.set({[msg.key]: msg.value}, () => {
          if(chrome.runtime.lastError) sendResponse({ok:false, error:chrome.runtime.lastError.message});
          else sendResponse({ok:true});
        });
        return;
      }
      default:
        sendResponse({ok:false, error:"unknown message"});
    }
  })();
  return true;
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// ── Background watchdog (MV3 alarms survive service-worker suspension) ─────
// Fires ~1/min: keeps the bridge WS warm and pulses hidden RoLink tabs so a
// throttled content loop resyncs. Never dispatches tools — content loop owns
// execution. `alarms` permission already declared in manifest.json.
try{
  if(chrome.alarms){
    chrome.alarms.create("rolink-tick", { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener((a)=>{
      if(!a || a.name !== "rolink-tick") return;
      if(!connected) connect();
      else send({type:"ping"}).catch(()=>{});
      try{
        chrome.tabs.query({url: PROVIDER_URLS.map(h=>"*://"+h+"/*")}, (tabs)=>{
          for(const t of tabs || []){
            try{ chrome.tabs.sendMessage(t.id, {type:"rolink-tick"}).catch(()=>{}); }catch{}
          }
        });
      }catch{}
    });
  }
}catch{}
