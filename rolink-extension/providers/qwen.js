// SPDX-License-Identifier: GPL-3.0-or-later
// providers/qwen.js — Qwen (chat.qwen.ai) provider.
//
// Qwen quirks handled here:
//  - Assistant code renders in Monaco, which collapses off-screen blocks to
//    their first line. Two nets: (1) a MutationObserver snapshots every
//    block's joined view-lines into pre.dataset.rlCode, keeping the LONGEST
//    capture so the full source survives disposal; (2) providers/qwen-net.js
//    (MAIN world) republishes the streamed answer's raw markdown, which
//    readAssistant() prefers when it is newer/longer than the DOM text.
//  - Turns virtualize: identity comes from the descendant
//    id="chat-response-message-<uuid>", immune to list swaps. itemKey exposes
//    it, giving the core a collision-proof per-turn key + dedupe.
//  - Model answers can render as an A/B carousel: isComparisonTurn detects it,
//    resolveComparison auto-picks the FIRST candidate (Response 1) so the loop
//    never stalls on an unresolved turn.
//  - Vision is per-model, not per-site: a live description scan decides
//    supportsVision dynamically (text-only models report no vision).
(function(){
  if(typeof window.makeGenericProvider !== "function") return;

  function viewLinesText(pre){
    var lines = pre.querySelectorAll ? pre.querySelectorAll(".view-line") : [];
    if(!lines.length) return "";
    var out = [];
    for(var i = 0; i < lines.length; i++) out.push(lines[i].textContent || "");
    return out.join("\n");
  }
  function snapshotCode(pre){
    try{
      var live = viewLinesText(pre);
      if(!live) return;
      var prev = pre.dataset.rlCode || "";
      if(live.length > prev.length) pre.dataset.rlCode = live;
    }catch(e){}
  }
  function codeText(pre){
    try{
      var cached = pre.dataset.rlCode || "";
      var live = viewLinesText(pre);
      var best = cached.length >= live.length ? cached : live;
      return best || pre.textContent || "";
    }catch(e){ return (pre && pre.textContent) || ""; }
  }
  var _codeObs = null;
  function ensureCodeObserver(){
    if(_codeObs) return;
    try{
      _codeObs = new MutationObserver(function(muts){
        for(var m = 0; m < muts.length; m++){
          var nodes = muts[m].addedNodes || [];
          for(var i = 0; i < nodes.length; i++){
            var n = nodes[i];
            if(!n || n.nodeType !== 1) continue;
            if(n.matches && n.matches("pre.qwen-markdown-code")) snapshotCode(n);
            var pres = n.querySelectorAll ? n.querySelectorAll("pre.qwen-markdown-code") : [];
            for(var j = 0; j < pres.length; j++) snapshotCode(pres[j]);
          }
        }
      });
      _codeObs.observe(document.documentElement, { childList: true, subtree: true });
    }catch(e){}
  }
  // Latest streamed raw markdown from the MAIN-world net tap.
  function netTap(){
    try{
      var n = document.getElementById("rl-qwen-net");
      if(!n || !n.textContent) return null;
      var o = JSON.parse(n.textContent);
      return (o && typeof o.text === "string") ? o : null;
    }catch(e){ return null; }
  }

  window.ZSProvider = window.makeGenericProvider({
    id: "qwen", displayName: "Qwen",
    selectors: {
      chatItem: ".qwen-chat-message, [data-message-id], [class*='message' i]",
      editor: "textarea.message-input-textarea, textarea, [contenteditable='true'], [role='textbox']",
      sendBtn: "button.send-button, button[aria-label*='Send' i], button[data-testid*='send' i], button[type='submit']"
    },
    isTooLongMsg: function(t){ return /too long|context|token limit|maximum/i.test(t || ""); },
    itemKey: function(it){
      if(!it) return null;
      try{
        var rc = it.querySelector ? it.querySelector('[id^="chat-response-message-"]') : null;
        if(rc && rc.id){
          var m = rc.id.match(/chat-response-message-([0-9a-f-]{8,})/i);
          if(m) return "qwen:" + m[1];
        }
      }catch(e){}
      var id = it.getAttribute && (it.getAttribute("data-message-id") || it.getAttribute("data-id") || it.id);
      if(id) return "qwen:" + id;
      return null;
    },
    augment: function(P){
      ensureCodeObserver();
      // Per-model vision gate: description scan first (most reliable), then
      // the model NAME as fallback — Qwen-VL / vision-named models see
      // images even when the picker is closed and the scan finds nothing.
      // Latches per model name so a closed picker keeps its verdict.
      var visCache = { model: null, vision: false, at: 0 };
      function currentModelName(){
        try{
          var el = document.querySelector("[class*='model-name' i], [class*='model-select' i]");
          return ((el && (el.textContent || "")).trim().slice(0, 80)) || null;
        }catch(e){ return null; }
      }
      Object.defineProperty(P, "supportsVision", {
        get: function(){
          try{
            var name = currentModelName();
            var now = Date.now();
            if(name && visCache.model === name && now - visCache.at < 10000) return visCache.vision;
            var txt = (document.body && document.body.textContent) || "";
            var vis = /supporting text and (image|vision)|vision capabilit|multimodal|多模态|视觉|图像理解/i.test(txt.slice(0, 20000));
            var textOnly = /text-only \(no vision\)|仅文本|不支持视觉|不支持图像/i.test(txt.slice(0, 20000));
            // Extra capability phrasings the base scan misses (kept strict —
            // the scan covers the whole body text, so generic words would
            // false-positive on chat content).
            var vis2 = /image understanding|visual understanding|understands (images|pictures)|can (see|view|read|process) images/i.test(txt.slice(0, 20000));
            var textOnly2 = /does not support (images|vision)|cannot process images|doesn'?t support vision/i.test(txt.slice(0, 20000));
            var visAll = vis || vis2, textOnlyAll = textOnly || textOnly2;
            var nm = String(name || "").toLowerCase();
            var nameVis = /(^|[^a-z])(vl|qvq|vision|visual|multimodal)([^a-z]|$)/.test(nm);
            var nameText = /text-only|text_only/.test(nm);
            var v = (nameText || textOnlyAll) ? false : (visAll || nameVis);
            if(name){ visCache = { model: name, vision: v, at: now }; }
            return v;
          }catch(e){ return false; }
        },
        configurable: true
      });
      // Prefer the net tap's raw markdown when it carries a tool signature
      // the DOM lost to Monaco disposal.
      var baseRead = P.readAssistant;
      P.readAssistant = function(){
        var r = baseRead();
        try{
          var tap = netTap();
          if(tap && tap.text){
            var domHas = /###MCP_TOOL###|###LUA###|"(tool|command)"\s*:/i.test(r.reply || "");
            var tapHas = /###MCP_TOOL###|###LUA###|"(tool|command)"\s*:/i.test(tap.text);
            if(tapHas && (!domHas || tap.text.length > (r.reply || "").length)) {
              r.reply = tap.text;
              r.rlFromNet = !tap.done;
            }
          }
        }catch(e){}
        return r;
      };
      // A turn still streaming its answer is unsettled for tool-shaped text.
      P.replyUnsettled = function(item){
        try{
          var tap = netTap();
          if(tap && tap.done === false) return true;
          var stop = document.querySelector("button.stop-button");
          return !!(stop && stop.offsetParent !== null);
        }catch(e){ return false; }
      };
      // A/B carousel: two candidates side by side in one turn.
      function dualItem(item){
        try{
          if(!item) return false;
          var cands = item.querySelectorAll("[class*='candidate' i], [class*='response-option' i], [data-index='1']");
          return cands && cands.length >= 2;
        }catch(e){ return false; }
      }
      P.isComparisonTurn = function(item){ return dualItem(item); };
      P.resolveComparison = function(){
        // Auto-pick the FIRST candidate (Response 1): its select button
        // precedes Response 2's in DOM order.
        try{
          var btns = document.querySelectorAll("button");
          var picks = [];
          for(var i = 0; i < btns.length; i++){
            var t = (btns[i].textContent || "").trim();
            if(/^response 1$/i.test(t) || /^回答 ?1$/i.test(t)) picks.push(btns[i]);
          }
          if(picks.length){ picks[0].click(); return true; }
          var item = P.lastAssistant && P.lastAssistant();
          if(item){
            var c = item.querySelectorAll("button");
            if(c.length){ c[0].click(); return true; }
          }
        }catch(e){}
        return false;
      };
      // Anchor chips inside the answer column, never the full-width turn row.
      var prevSpot = P.findToolBlockSpot;
      P.findToolBlockSpot = function(item, chip){
        if(!item) return null;
        try{
          var host = item.querySelector(".chat-response-message-right") ||
                     item.querySelector(".chat-response-message") || null;
          if(host){
            host.classList.add("rl-cmd-mask");
            return { parent: host, ref: host.firstElementChild || null };
          }
        }catch(e){}
        try{ return prevSpot(item, chip); }catch(e){ return null; }
      };
    }
  });
})();
