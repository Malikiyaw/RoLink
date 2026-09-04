// SPDX-License-Identifier: GPL-3.0-or-later
// providers/qwen-net.js — Qwen streamed-answer tap (MAIN world).
//
// WHY: Qwen renders fenced code inside a Monaco editor that collapses
// off-screen blocks to their first line, so reading a tool call back from the
// DOM is unreliable (an opener with no body/closer hangs the agent loop).
// The streamed chat-completions response carries the assistant's RAW markdown
// verbatim, so this script wraps window.fetch in the PAGE world (an isolated
// wrap would never see the app's own calls), folds the `answer`-phase deltas
// per response, and republishes the latest full text + done flag into a DOM
// node (#rl-qwen-net, JSON textContent) the isolated provider can read.
//
// The true end of a turn is the stream closing ([DONE] / reader end) — never
// an early `status:"finished"` delta, which can precede the stream end by
// seconds while the closing marker is still in flight.
(function(){
  "use strict";
  if(window.__rlQwenNet) return;
  window.__rlQwenNet = true;

  // Load-safe: the providers.test.js sandbox has no DOM/fetch. Real MAIN
  // world always has both; this only skips the bare sandbox.
  if(typeof document === "undefined" || typeof window.fetch !== "function") return;

  var NODE_ID = "rl-qwen-net";
  function node(){
    var n = document.getElementById(NODE_ID);
    if(!n){
      n = document.createElement("script");
      n.type = "application/json";
      n.id = NODE_ID;
      (document.body || document.documentElement).appendChild(n);
    }
    return n;
  }
  function publish(obj){ try{ node().textContent = JSON.stringify(obj); }catch(e){} }

  function foldLine(line, acc){
    var s = String(line).trim();
    if(s.indexOf("data:") !== 0) return acc;
    var js = s.slice(5).trim();
    if(!js) return acc;
    if(js === "[DONE]"){ acc.done = true; return acc; }
    var o;
    try{ o = JSON.parse(js); }catch(e){ return acc; }
    var created = o && o["response.created"];
    if(created && created.response_id){ acc.rid = created.response_id; acc.text = ""; acc.done = false; }
    var d = o && o.choices && o.choices[0] && o.choices[0].delta;
    if(d && d.phase === "answer" && typeof d.content === "string") acc.text += d.content;
    return acc;
  }

  function consume(resp){
    var reader;
    try{ reader = resp.body.getReader(); }catch(e){ return; }
    var dec = new TextDecoder();
    var buf = "";
    var acc = { rid: null, text: "", done: false };
    function pump(){
      reader.read().then(function(r){
        if(r.done){
          if(buf) foldLine(buf, acc);
          acc.done = true;
          publish({ rid: acc.rid, text: acc.text, done: acc.done, t: Date.now() });
          return;
        }
        try{ buf += dec.decode(r.value, { stream: true }); }catch(e){}
        var idx;
        while((idx = buf.indexOf("\n")) >= 0){
          foldLine(buf.slice(0, idx), acc);
          buf = buf.slice(idx + 1);
        }
        publish({ rid: acc.rid, text: acc.text, done: acc.done, t: Date.now() });
        pump();
      }, function(){
        acc.done = true;
        publish({ rid: acc.rid, text: acc.text, done: acc.done, t: Date.now() });
      });
    }
    pump();
  }

  try{
    var origFetch = window.fetch;
    window.fetch = function(){
      var url = (arguments[0] && arguments[0].url) || arguments[0];
      var p = origFetch.apply(this, arguments);
      try{
        if(typeof url === "string" && /\/chat\/completions/i.test(url)){
          p.then(function(res){
            try{ if(res && res.body) consume(res.clone()); }catch(e){}
          }, function(){});
        }
      }catch(e){}
      return p;
    };
  }catch(e){}
})();
