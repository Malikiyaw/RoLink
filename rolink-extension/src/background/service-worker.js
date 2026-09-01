// MV3 service worker — stateless, reconnect WS, alarms keepalive
let ws = null;
let token = null;
let reconnectTimer = null;
const WS_URL_BASE = "ws://127.0.0.1:17613/ws";
const MCP_URL = "http://127.0.0.1:3001";

async function getToken(){
  if(token) return token;
  const cfg = await chrome.storage.local.get(["rolink_token"]);
  if(cfg.rolink_token) token = cfg.rolink_token;
  else {
    token = Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);
    await chrome.storage.local.set({ rolink_token: token });
  }
  return token;
}

async function connectWS(){
  try{
    const t = await getToken();
    const url = `${WS_URL_BASE}?role=extension&token=${encodeURIComponent(t)}`;
    ws = new WebSocket(url);
    ws.onopen = ()=> { console.log("[rolink SW] ws open"); chrome.alarms.create("rolink-heartbeat", {periodInMinutes: 0.33}); };
    ws.onclose = ()=> { console.log("[rolink SW] ws close, reconnect in 3s"); scheduleReconnect(); };
    ws.onerror = ()=> { try{ws.close();}catch{} };
    ws.onmessage = (ev)=>{
      try{
        const msg = JSON.parse(ev.data);
        if(msg.method === "enqueue_command"){
          console.log("[rolink SW] broadcast", msg);
        }
      }catch{}
    };
  }catch(e){ console.warn("[rolink SW] connect failed", e); scheduleReconnect(); }
}

function scheduleReconnect(){
  if(reconnectTimer) return;
  reconnectTimer = setTimeout(()=>{ reconnectTimer=null; connectWS(); }, 3000);
}

async function enqueueToMCP(payload){
  // try WS first, fallback to HTTP
  const t = await getToken();
  const frame = { v:1, id: Date.now().toString(36), method:"enqueue_command", role:"extension", token:t, payload };
  if(ws && ws.readyState===1){
    ws.send(JSON.stringify(frame));
    return { ok:true, via:"ws" };
  }
  // http fallback
  try{
    const res = await fetch(`${MCP_URL}/queue/enqueue`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload) });
    return await res.json();
  }catch(e){ return { ok:false, error: String(e) }; }
}

// keepalive
chrome.alarms.onAlarm.addListener((a)=>{
  if(a.name==="rolink-heartbeat"){
    if(ws && ws.readyState===1) ws.send(JSON.stringify({v:1,id:"hb",method:"heartbeat"}));
    else connectWS();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  (async()=>{
    if(!msg || !msg.type) return;
    if(msg.type==="rolink:hello"){ sendResponse({ok:true}); return; }
    if(msg.type==="rolink:enqueue"){
      const res = await enqueueToMCP(msg.payload);
      sendResponse(res);
      return;
    }
    // generic fetch intercept forwarding
    if(msg.type.startsWith("rolink:")){
      // optionally forward to MCP as command? for now just log
      console.log("[rolink SW] intercept", msg.type, String(msg.payload).slice(0,300));
      sendResponse({ok:true});
    }
  })();
  return true; // async
});

// init
getToken().then(connectWS);
chrome.runtime.onInstalled.addListener(()=>{ connectWS(); });

console.log("[rolink SW] loaded");
