const b=document.getElementById('bridge'), m=document.getElementById('mcp'), s=document.getElementById('status');
chrome.storage.local.get(['bridgeUrl','mcpUrl'], v=>{ if(v.bridgeUrl) b.value=v.bridgeUrl; if(v.mcpUrl) m.value=v.mcpUrl; });
document.getElementById('save').onclick=()=>{
  chrome.storage.local.set({bridgeUrl:b.value, mcpUrl:m.value}, ()=>{ s.textContent='Saved'; setTimeout(()=>s.textContent='',1500); });
};
