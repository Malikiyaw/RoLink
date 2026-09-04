// SPDX-License-Identifier: GPL-3.0-or-later
// providers/arena.js — Arena (arena.ai, lmarena.ai) provider.
//
// Arena quirks handled here:
//  - Chat modes: Direct (1 model) / Battle / Side-by-Side. Only DIRECT is
//    supported — a comparison turn has no single reply to parse or feed.
//    ensureComposerReady refuses non-Direct modes, and restoreDirectOnce()
//    flips a fresh page back to Direct a single time per load (never on a
//    sweep, so a deliberate user switch later is respected).
//  - Sends are send-until-clear: the editor clears the instant Arena accepts
//    a message, so typeAndSend re-clicks until the editor empties or a
//    generation starts (a single swallowed click never strands a result).
(function(){
  if(typeof window.makeGenericProvider !== "function") return;
  window.ZSProvider = window.makeGenericProvider({
    id: "arena", displayName: "Arena",
    selectors: {
      chatItem: "[data-testid*='message' i], [class*='message' i], [class*='response' i]",
      editor: "textarea, [contenteditable='true'], [role='textbox']",
      sendBtn: "button[aria-label*='Send' i], button[data-testid*='send' i], button[type='submit']"
    },
    augment: function(P){
      var MODE_RE = /\b(direct|battle|agent|side by side)\b/i;
      function comboText(){
        try{
          var el = document.querySelector("[class*='mode' i] button, [class*='conversation-mode' i], [role='combobox']");
          return ((el && (el.textContent || "")) || "").trim();
        }catch(e){ return ""; }
      }
      P.arenaMode = function(){
        var m = comboText().match(MODE_RE);
        return m ? m[1].toLowerCase() : "unknown";
      };
      // Direct-only gate: refuse to start on Battle / Side-by-Side.
      var prevReady = P.ensureComposerReady;
      P.ensureComposerReady = function(reason){
        var mode = "unknown";
        try{ mode = P.arenaMode(); }catch(e){}
        if(mode && mode !== "direct" && mode !== "unknown"){
          return Promise.resolve({ ready: false, reason: "Arena requires Direct mode (1 model) — Battle / Side-by-Side have no single reply to drive." });
        }
        return prevReady(reason);
      };
      // One-shot restore: flip a fresh page back to Direct once per load.
      var _restored = false;
      function pickDirectOption(){
        try{
          var opts = document.querySelectorAll("[role='option'], li button, div[role='menuitem']");
          for(var i = 0; i < opts.length; i++){
            if(/^\s*direct/i.test(opts[i].textContent || "")){ opts[i].click(); return true; }
          }
        }catch(e){}
        return false;
      }
      P.restoreDirectOnce = function(){
        if(_restored) return Promise.resolve(false);
        _restored = true;
        return new Promise(function(res){
          var mode = "unknown";
          try{ mode = P.arenaMode(); }catch(e){}
          if(/direct/i.test(mode || "")) return res(false);
          try{
            var combo = document.querySelector("[role='combobox']");
            if(combo){ try{ combo.click(); }catch(e){} }
          }catch(e){}
          var t0 = Date.now();
          (function loop(){
            if(pickDirectOption()) return res(true);
            if(Date.now() - t0 > 2000) return res(false);
            setTimeout(loop, 120);
          })();
        });
      };
      try{
        if(typeof P.init === "function"){
          var prevInit = P.init;
          P.init = function(a){ try{ prevInit(a); }catch(e){} setTimeout(function(){ try{ P.restoreDirectOnce(); }catch(e){} }, 1500); };
        }
      }catch(e){}
      // Send-until-clear: re-click until the editor empties or generation
      // starts (bounded ~8s), so one swallowed click never drops a result.
      var baseSend = P.typeAndSend;
      P.typeAndSend = function(text, images){
        return baseSend(text, images).then(function(){
          return new Promise(function(res){
            var t0 = Date.now();
            (function loop(){
              var ed = null;
              try{ ed = P.getEditor ? P.getEditor() : null; }catch(e){}
              var empty = !ed || ((ed.value != null ? ed.value : ed.textContent || "").trim() === "");
              var gen = false;
              try{ gen = P.isGenerating && P.isGenerating(); }catch(e){}
              if(empty || gen) return res(true);
              if(Date.now() - t0 > 8000) return res(false);
              try{
                var btn = document.querySelector("button[aria-label*='Send' i], button[type='submit']");
                if(btn && btn.getAttribute("aria-disabled") !== "true") btn.click();
              }catch(e){}
              setTimeout(loop, 250);
            })();
          });
        });
      };
      // A modal dialog above the composer: park the bar.
      P.overlayBlocking = function(){
        try{
          var m = document.querySelector("[role='dialog'], [data-state='open'][data-radix-popper-content-wrapper]");
          return !!(m && m.offsetParent !== null);
        }catch(e){ return false; }
      };
      var prevSpot = P.findToolBlockSpot;
      P.findToolBlockSpot = function(item, chip){
        if(!item) return null;
        try{ if(item.classList) item.classList.add("rl-cmd-mask"); }catch(e){}
        try{
          var r = prevSpot(item, chip);
          if(r && r.parent) return r;
        }catch(e){}
        return null;
      };
    }
  });
})();
