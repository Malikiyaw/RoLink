// SPDX-License-Identifier: GPL-3.0-or-later
// providers/meta.js — Meta AI (meta.ai) provider.
//
// Full turn-level adapter (ported from the proven ZeroScript meta adapter,
// renamed to RoLink rl- markers). Meta AI quirks handled here:
//  - Turn list: the message list is a <div class="flex flex-col"> whose direct
//    children are turns; an ASSISTANT turn holds [data-testid="assistant-message"].
//    Substring selectors ([class*='message']) match nested fragments — never use
//    them for turn identity. A leading pointer-events-none absolute spacer is not
//    a turn.
//  - Reasoning ("Réflexion") renders INSIDE the assistant message as
//    [data-testid="thinking-status"] / [data-testid="subagent-cot-list"] and is
//    excluded from every read.
//  - Tool JSON renders in a viewer widget (.ur-code-block, JSON/Tree/Raw tabs).
//    Tree view interleaves ▶/▼ glyphs and ABRIDGES long values ("[N items]").
//    Command-shaped viewers are flipped to Raw once; the text is de-chromed.
//  - Plain ``` blocks are <pre> whose lines are block spans with NO newline text
//    nodes — textContent collapses them; lines are re-joined with "\n".
//  - Generation signal: [data-testid="composer-stop-button"] present = working
//    (authoritative through the whole reasoning phase).
//  - React reconciles turn subtrees: chips anchor into the centered content
//    column and the turn body keeps .rl-cmd-mask so recreated code stays hidden.
//  - Meta exposes no per-turn stopped/continue markers: findContinueBtn → null.
(function(){
  if(typeof window.makeGenericProvider !== "function") return;

  var ASST = '[data-testid="assistant-message"]';
  var REASONING = '[data-testid="thinking-status"],[data-testid="subagent-cot-list"]';
  var CODE_WRAP = ".ur-code-block";
  var STOP_BTN = '[data-testid="composer-stop-button"]';
  var TRI_RE = /[▲▴▶▸►▼▾◀◂]/g;
  var CMD_SHAPE = /"(?:command|tool)"\s*:\s*"|###\s*lua|###mcp_tool###/i;

  var _rawDone = new WeakSet();
  var _idMap = new WeakMap();
  var _idSeq = 0;

  // The message list: <div class="flex flex-col"> holding an assistant-message
  // with 2+ child turns. Null on a fresh/empty chat.
  function listEl(){
    var any = null;
    try{ any = document.querySelector(ASST); }catch(e){ return null; }
    if(!any) return null;
    var n = any.parentElement;
    for(var i = 0; i < 12 && n; i++, n = n.parentElement){
      try{
        if(n.classList && n.classList.contains("flex") && n.classList.contains("flex-col") &&
           n.children.length >= 2 && n.querySelector(ASST)) return n;
      }catch(e){}
    }
    return null;
  }
  function isTurnChild(c){
    if(!c || !c.classList) return false;
    try{
      if(c.classList.contains("pointer-events-none") && c.classList.contains("absolute")) return false;
      if(c.querySelector && c.querySelector(ASST)) return true;
      return ((c.textContent || "").trim().length > 0);
    }catch(e){ return false; }
  }
  function domTurns(){
    var list = listEl();
    if(!list) return [];
    var out = [];
    var kids = list.children;
    for(var i = 0; i < kids.length; i++) if(isTurnChild(kids[i])) out.push(kids[i]);
    return out;
  }
  function isAssistantItem(item){
    try{ return !!(item && item.querySelector && item.querySelector(ASST)); }catch(e){ return false; }
  }
  function isUserItem(item){ return !!item && !isAssistantItem(item); }
  function bodyOf(item){
    if(!item) return null;
    try{ return isAssistantItem(item) ? item.querySelector(ASST) : item; }catch(e){ return item; }
  }
  function lastAssistant(){
    var turns = domTurns();
    for(var i = turns.length - 1; i >= 0; i--) if(isAssistantItem(turns[i])) return turns[i];
    return null;
  }
  function lastAssistantId(){
    var it = lastAssistant();
    if(!it) return null;
    var id = _idMap.get(it);
    if(!id){ id = ++_idSeq; try{ _idMap.set(it, id); }catch(e){} }
    return "meta:" + id;
  }

  // Flip a command-shaped JSON viewer to its Raw tab once. Tree view abridges
  // long values and interleaves expander glyphs; Raw renders a verbatim <pre>.
  // Only command-shaped blocks are touched — anything else is left alone.
  function ensureRawView(wrap){
    if(!wrap || _rawDone.has(wrap)) return;
    try{
      var txt = wrap.textContent || "";
      if(!/"(?:command|tool)"\s*:/.test(txt)) return;
      var btns = wrap.querySelectorAll("button, [role='tab']");
      for(var i = 0; i < btns.length; i++){
        if((btns[i].textContent || "").trim().toLowerCase() === "raw"){
          btns[i].click();
          break;
        }
      }
    }catch(e){}
    _rawDone.add(wrap);
  }
  // Strip viewer chrome: expander triangles, then the leading JSONTreeRaw
  // toolbar text. Trailing chrome is harmless (brace-matched extraction).
  function cleanJsonViewer(text){
    var t = String(text || "").replace(TRI_RE, "");
    var i = t.indexOf("{");
    return i > 0 ? t.slice(i) : t;
  }
  // Rebuild a <pre>'s source: Meta renders each code line as a block span with
  // no newline text nodes — join the line children with "\n".
  function preText(pre){
    try{
      var code = (pre.querySelector && pre.querySelector("code")) || pre;
      var lines = [];
      var kids = code.children || [];
      for(var i = 0; i < kids.length; i++) if(kids[i].nodeType === 1) lines.push(kids[i].textContent);
      if(lines.length) return lines.join("\n");
      return code.textContent || "";
    }catch(e){ return ""; }
  }
  // Walk the tree skipping our chips, reasoning blocks, and an optional extra
  // subtree. Uses textContent (never innerText): display:none-injected turns
  // must stay enumerable so their result chips still render.
  function textWithout(rootEl, excludeSel){
    if(!rootEl) return "";
    var skip = ".rl-chip, " + REASONING + (excludeSel ? ", " + excludeSel : "");
    var t = "";
    function walk(n){
      if(n.nodeType === 3){ t += n.nodeValue; return; }
      if(n.nodeType !== 1) return;
      try{ if(n.matches && n.matches(skip)) return; }catch(e){}
      try{
        if(n.matches && n.matches(CODE_WRAP) && !n.querySelector("pre")){
          ensureRawView(n);
          t += cleanJsonViewer(n.textContent || "");
          return;
        }
      }catch(e){}
      if(n.tagName === "PRE"){ t += preText(n); return; }
      var kids = n.childNodes;
      for(var i = 0; i < kids.length; i++) walk(kids[i]);
    }
    try{ walk(rootEl); }catch(e){}
    return t;
  }
  function itemText(item){
    var b = bodyOf(item);
    return b ? textWithout(b) : "";
  }

  // Anchor chips into the reply's CENTERED content column (mx-auto max-w-*
  // flex-col), not the full-width turn: caps the chip to text width and keeps
  // it above the like/copy action bar. Falls back to the body, never null.
  function chipColumn(item){
    var b = bodyOf(item) || item;
    try{
      var divs = b.querySelectorAll ? b.querySelectorAll("div") : [];
      for(var i = 0; i < divs.length; i++){
        var c = divs[i].className || "";
        if(/mx-auto/.test(c) && /max-w-/.test(c) && /flex-col/.test(c) && !/actions/.test(c)) return divs[i];
      }
    }catch(e){}
    return b;
  }

  // Hide every command-shaped code wrapper + bare command block under the turn
  // body; mark the body .rl-cmd-mask so React-recreated code stays hidden via
  // overlay.css. Returns the first hide spot for chip anchoring. Never returns
  // null for a live item (falls back to the content column) — the core must
  // always have an anchor inside the turn, never document.body.
  function findToolBlockSpot(item, chip){
    if(!item) return null;
    try{ if(item.classList) item.classList.add("rl-cmd-mask"); }catch(e){}
    var b = bodyOf(item) || item;
    var hid = null;
    try{
      var wraps = b.querySelectorAll ? b.querySelectorAll(CODE_WRAP) : [];
      for(var i = 0; i < wraps.length; i++){
        var cw = wraps[i];
        try{ if(cw.closest && cw.closest(".rl-chip")) continue; }catch(e){}
        if(CMD_SHAPE.test(cw.textContent || "")){
          try{ cw.classList.add("rl-tool-hide"); }catch(e){}
          try{ b.classList.add("rl-cmd-mask"); }catch(e){}
          if(!hid && cw.parentElement) hid = { parent: cw.parentElement, ref: cw };
        }
      }
      // Bare blocks: long sessions stop fencing the JSON — a top-level p/div
      // STARTING with the command is a command no matter its size; the 600-char
      // cap only guards blocks where the shape appears mid-text.
      var blocks = b.querySelectorAll ? b.querySelectorAll("p, div") : [];
      for(var j = 0; j < blocks.length; j++){
        var el = blocks[j];
        try{ if(el.closest && el.closest(".rl-chip, .rl-tool-hide, " + CODE_WRAP)) continue; }catch(e){}
        try{ if(el.querySelector && el.querySelector(CODE_WRAP)) continue; }catch(e){}
        var t = ((el.textContent || "").trim());
        if(!t) continue;
        var t0 = t.replace(/^json\s*/i, "");
        var startsAsCmd = /^\{\s*"(?:command|tool)"\s*:/.test(t0) || /^###\s*(?:lua|mcp_tool)/i.test(t0);
        if((startsAsCmd || t.length < 600) && CMD_SHAPE.test(t) && /^[{#]/.test(t0)){
          try{ el.classList.add("rl-tool-hide"); }catch(e){}
          if(!hid && el.parentElement) hid = { parent: el.parentElement, ref: el };
        }
      }
    }catch(e){}
    if(hid && hid.parent) return hid;
    try{
      var anchor = chipColumn(item) || b;
      if(anchor) return { parent: anchor, ref: null };
    }catch(e){}
    return null;
  }

  function stopPresent(){
    try{
      var b = document.querySelector(STOP_BTN);
      return !!(b && b.offsetParent !== null);
    }catch(e){ return false; }
  }

  window.ZSProvider = window.makeGenericProvider({
    id: "meta", displayName: "Meta AI",
    selectors: {
      editor: "[data-testid='composer-input'], textarea, [contenteditable='true'], [role='textbox']",
      sendBtn: "[data-testid='composer-send-button'], button[aria-label*='Send' i], button[data-testid*='send' i], button[type='submit']"
    },
    timings: {
      GEN_IDLE_MS: 1500, REASON_IDLE_MS: 12000, WARMUP_MS: 45000,
      REASON_NOREPLY_MS: 90000, STABLE_MS: 9000, RESPONSE_TIMEOUT_MS: 300000
    },
    augment: function(P){
      P.allItems = domTurns;
      P.isUserItem = isUserItem;
      P.isAssistantItem = isAssistantItem;
      P.itemText = itemText;
      P.lastAssistant = lastAssistant;
      P.lastAssistantId = lastAssistantId;
      P.readAssistant = function(){
        var item = lastAssistant();
        if(!item) return { present: false, reply: "", thinking: "", item: null };
        var b = bodyOf(item);
        var t = "";
        try{ t = b ? textWithout(b, ".rl-chip") : ""; }catch(e){}
        return { present: true, reply: t.trim(), thinking: "", item: item };
      };
      P.streamLen = function(it){
        var b = bodyOf(it === undefined ? lastAssistant() : it);
        return b ? textWithout(b, ".rl-chip").length : 0;
      };
      // Stop button is the authoritative signal through the whole reasoning
      // phase; otherwise fall back to the generic stream-growth window.
      var prevGen = P.isGenerating;
      P.isGenerating = function(){
        if(stopPresent()) return true;
        try{ return prevGen(); }catch(e){ return false; }
      };
      P.isHardGenerating = function(){ return stopPresent(); };
      // Meta exposes no per-turn stopped/continue markers. The generic
      // Continue-button regex matches persistent suggestion buttons and would
      // divert abridged JSON to "truncated" — disable it here.
      P.findContinueBtn = function(){ return null; };
      P.findToolBlockSpot = findToolBlockSpot;
      // Reasoning subtree exclusion for the core's whole-item text join.
      P.thinkingSel = REASONING;
      try{
        if(P.conversationKey){
          var prevKey = P.conversationKey;
          P.conversationKey = function(){
            try{ return location.pathname === "/" ? "" : prevKey(); }catch(e){ return location.pathname; }
          };
        }
      }catch(e){}
    }
  });
})();
