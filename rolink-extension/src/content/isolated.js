// world:ISOLATED — receives postMessage from MAIN, forwards to SW via runtime
(function(){
  // inject MAIN script
  try{
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("src/content/main.js");
    s.onload = ()=> s.remove();
    (document.documentElement || document.head).appendChild(s);
  }catch(e){ console.warn("[rolink] inject failed", e); }

  window.addEventListener("message", (event)=>{
    if(event.data && event.data.source === "rolink-main"){
      const {type, payload} = event.data;
      try{ chrome.runtime.sendMessage({ type: "rolink:"+type, payload }); }catch{}
      // also auto-forward code blocks to bridge via SW
      if(type === "code_block"){
        chrome.runtime.sendMessage({ type: "rolink:enqueue", payload: { tool: "run_code", command: payload, args: {} } });
      }
    }
  });

  // let SW know we are ready
  try{ chrome.runtime.sendMessage({ type:"rolink:hello", payload:{ href: location.href } }); }catch{}
})();
