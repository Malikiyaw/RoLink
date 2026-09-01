const b=document.getElementById("bridge"), m=document.getElementById("mcp"), s=document.getElementById("status"), ver=document.getElementById("ver");
chrome.storage.local.get(["bridgeUrl","mcpUrl"], v=>{ if(v.bridgeUrl) b.value=v.bridgeUrl; if(v.mcpUrl) m.value=v.mcpUrl; });
chrome.runtime.sendMessage({type:"version"}, r=>{ if(r&&r.version) ver.textContent="v"+r.version; });
function save(){
  chrome.storage.local.set({bridgeUrl:b.value.trim(), mcpUrl:m.value.trim()}, ()=>{
    s.textContent="Saved"; s.className="status ok";
    setTimeout(()=>{ s.textContent=""; s.className="status"; },1800);
  });
}
document.getElementById("save").onclick=save;
b.onkeydown=m.onkeydown=(e)=>{ if(e.key==="Enter") save(); };
document.getElementById("reset").onclick=()=>{
  b.value="ws://127.0.0.1:17613"; m.value="http://127.0.0.1:3001"; save();
};
