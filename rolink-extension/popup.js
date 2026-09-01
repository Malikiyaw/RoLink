const dot=document.getElementById("dot"), txt=document.getElementById("txt");
function set(s){
  if(s==="ready"){ dot.style.background="green"; txt.textContent="Bridge + Studio ready"; }
  else if(s==="bridge"){ dot.style.background="yellow"; txt.textContent="Bridge OK, open Studio place"; }
  else { dot.style.background="grey"; txt.textContent="Bridge offline — run start.bat"; }
}
async function check(){
  try{ const r=await fetch("http://127.0.0.1:3001/health"); if(r.ok) return set("ready"); }catch{}
  try{ const ws=new WebSocket("ws://127.0.0.1:17613/ws?role=popup"); ws.onopen=()=>set("bridge"); ws.onerror=()=>set("offline"); setTimeout(()=>ws.close(),800); }catch{ set("offline"); }
}
check(); setInterval(check,3000);
document.getElementById("reconnect").onclick=check;
document.getElementById("restart").onclick=async()=>{ try{ await fetch("http://127.0.0.1:17613",{method:"POST",body:JSON.stringify({id:"rst",method:"restart"})}); }catch{} chrome.tabs.reload(); };
document.getElementById("settings").onclick=()=>{
  if(chrome.runtime.openOptionsPage){
    try{ chrome.runtime.openOptionsPage(()=>{ if(chrome.runtime.lastError) window.open(chrome.runtime.getURL("options.html")); }); }
    catch{ window.open(chrome.runtime.getURL("options.html")); }
  } else {
    window.open(chrome.runtime.getURL("options.html"));
  }
};
