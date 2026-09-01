// world:MAIN — injected via web_accessible_resources, runs at document_start
// clones fetch/XHR + SSE parser, redacts before postMessage to ISOLATED
(function(){
  const REDACT = [/Authorization/i, /cookie/i, /token/i, /pass|secret/i, /\b\d{16}\b/, /sk-[a-zA-Z0-9]{20,}/];
  function redact(text){
    try{
      let t = String(text);
      for(const re of REDACT) if(re.test(t)) return "[REDACTED]";
      return t.slice(0, 64000);
    }catch{return "[redact error]";}
  }
  function emit(type, payload){
    window.postMessage({ source: "rolink-main", type, payload: redact(JSON.stringify(payload)).slice(0,64000) }, "*");
  }

  // Wrap fetch
  const origFetch = window.fetch;
  window.fetch = async function(...args){
    const res = await origFetch.apply(this, args);
    try{
      const clone = res.clone();
      const url = String(args[0]);
      const isChat = /\/backend-api\/conversation|\/api\/chat|deepseek|claude|gemini/i.test(url);
      if(isChat){
        clone.text().then(txt=>{
          if(txt.includes("[DONE]") || txt.includes("content_block_stop") ) emit("sse_done", {url, preview: txt.slice(0,2000)});
          else emit("fetch_chunk", {url, preview: txt.slice(0,2000)});
        }).catch(()=>{});
      }
    }catch{}
    return res;
  };

  // Wrap XHR
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url){ this._rolinkUrl = String(url); return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(){
    this.addEventListener("load", function(){
      try{
        if(/backend-api|api\/chat/i.test(this._rolinkUrl||"")){
          emit("xhr_response", {url: this._rolinkUrl, status: this.status, preview: (this.responseText||"").slice(0,2000)});
        }
      }catch{}
    });
    return origSend.apply(this, arguments);
  };

  // Detect code blocks via MutationObserver
  const obs = new MutationObserver(()=>{
    const blocks = document.querySelectorAll("pre code");
    if(blocks.length) {
      const last = blocks[blocks.length-1];
      const code = last.innerText.slice(0,4000);
      if(code.includes("Instance")||code.includes("script")||code.includes("local ")) emit("code_block", {code});
    }
  });
  try{ obs.observe(document.documentElement, {childList:true, subtree:true}); }catch{}

  emit("hello", {msg:"rolink MAIN injected", href: location.href});
})();
