// SPDX-License-Identifier: GPL-3.0-or-later
// providers/chatgpt-cm.js — ChatGPT code-view true-document tap (MAIN world).
//
// WHY: ChatGPT renders fenced code through a virtualized code view where each
// source line is its own element and long lines are rendered only partially
// (measured: ~2k chars visible of a ~10k-char document). The page-side editor
// state holds the FULL document on an expando that isolated-world content
// scripts cannot see, so this MAIN-world script republishes each block's true
// document text into a DOM attribute the isolated provider can read.
//
// Protocol: the isolated provider dispatches a synchronous "rl-cm-sync"
// CustomEvent on document; this listener refreshes every attribute before the
// dispatch returns, so the read in the same tick is current. A 1s idle sync
// keeps attributes warm for blocks that finish streaming between reads.
// Absent attributes simply mean "fall back to joining rendered lines".
(function(){
  "use strict";
  if(window.__rlChatgptCm) return;
  window.__rlChatgptCm = true;

  // Load-safe: the providers.test.js sandbox has no DOM. In a real MAIN
  // world document/window always exist, so this only skips the test sandbox.
  if(typeof document === "undefined" || !document.querySelectorAll) return;

  var ATTR = "data-rl-cm";
  var LEN = "data-rl-cm-len";
  var seen = new WeakMap();

  function viewOf(content){
    try{
      var t = content && content.cmTile;
      if(!t) return null;
      return t.view || (t.dom && t.dom.cmTile && t.dom.cmTile.view) || null;
    }catch(e){ return null; }
  }
  function docOf(content){
    var v = viewOf(content);
    if(!v) return null;
    try{
      var st = v.state || (v.viewState && v.viewState.state);
      return st && st.doc ? st.doc : null;
    }catch(e){ return null; }
  }
  function syncOne(content){
    var doc = docOf(content);
    if(!doc) return false;
    var len = doc.length;
    if(seen.get(content) === len && content.hasAttribute(ATTR)) return true;
    var text;
    try{ text = doc.toString(); }catch(e){ return false; }
    try{
      content.setAttribute(ATTR, text);
      content.setAttribute(LEN, String(len));
      seen.set(content, len);
    }catch(e){ return false; }
    return true;
  }
  function syncAll(){
    var n = 0;
    try{
      var list = document.querySelectorAll(".cm-content");
      for(var i = 0; i < list.length; i++) if(syncOne(list[i])) n++;
    }catch(e){}
    return n;
  }

  document.addEventListener("rl-cm-sync", function(){ try{ syncAll(); }catch(e){} }, true);
  setInterval(function(){ try{ syncAll(); }catch(e){} }, 1000);
  try{ syncAll(); }catch(e){}
})();