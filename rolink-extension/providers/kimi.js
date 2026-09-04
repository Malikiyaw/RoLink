// SPDX-License-Identifier: GPL-3.0-or-later
// providers/kimi.js — Kimi (kimi.ai) provider.
//
// Kimi quirks handled here:
//  - Served from kimi.ai (manifest matches kimi.ai + www.kimi.ai).
//  - Kimi's OWN agentic mode ("K3 Swarm" / "Agent") makes the model reach for
//    its built-in tools instead of the RoLink block protocol. ensureComposer
//    steers the picker to a plain model (K3 / instant), nativeAgentModeOn()
//    detects the agentic pick, and modeWarning() gives the core an actionable
//    banner string while it is on.
//  - Login / modal masks (.login-modal-mask, .modal-mask) sit above the page:
//    overlayBlocking() reports them so the core parks the bar instead of
//    covering a button the user must click.
(function(){
  if(typeof window.makeGenericProvider !== "function") return;
  window.ZSProvider = window.makeGenericProvider({
    id: "kimi", displayName: "Kimi",
    selectors: {
      chatItem: "[data-message-id], [data-testid*='message' i], .chat-message, [class*='message' i]",
      editor: "textarea, [contenteditable='true'], [role='textbox']",
      sendBtn: "button[aria-label*='Send' i], button[data-testid*='send' i], button[type='submit']"
    },
    isTooLongMsg: function(t){ return /too long|context|token limit|maximum/i.test(t || ""); },
    findContinueBtn: function(){ return null; },
    augment: function(P){
      function pickerText(){
        try{
          var el = document.querySelector("[class*='model-picker' i], [class*='model-select' i], [class*='models-popover' i]");
          return ((el && (el.textContent || "")) || "").trim();
        }catch(e){ return ""; }
      }
      // Kimi's native agentic mode is on when the picker names Swarm/Agent.
      P.nativeAgentModeOn = function(){
        try{ return /swarm|agent/i.test(pickerText()); }catch(e){ return false; }
      };
      P.modeWarning = function(){
        if(P.nativeAgentModeOn()){
          return "Switch the model picker off K3 Swarm (pick K3 or Instant) — " +
            "Kimi's own agentic mode replaces RoLink tool blocks with its native tools and breaks the loop.";
        }
        return "";
      };
      // A login modal or blocking mask above the composer: park the bar.
      P.overlayBlocking = function(){
        try{
          var m = document.querySelector(".login-modal-mask, .modal-mask, [role='dialog']");
          return !!(m && m.offsetParent !== null);
        }catch(e){ return false; }
      };
      // Steer a fresh composer away from the agentic Swarm pick toward a
      // plain model; never auto-select Swarm itself.
      var prevReady = P.ensureComposerReady;
      P.ensureComposerReady = function(reason){
        try{
          if(P.nativeAgentModeOn() && reason === "startup"){
            var opts = document.querySelectorAll("button, [role='option']");
            for(var i = 0; i < opts.length; i++){
              var t = (opts[i].textContent || "").trim();
              if(/^k3$/i.test(t) || /instant/i.test(t)){ try{ opts[i].click(); }catch(e){} break; }
            }
          }
        }catch(e){}
        return prevReady(reason);
      };
      var prevSpot = P.findToolBlockSpot;
      P.findToolBlockSpot = function(item, chip){
        if(!item) return null;
        try{ item.classList.add("rl-cmd-mask"); }catch(e){}
        try{
          var r = prevSpot(item, chip);
          if(r && r.parent) return r;
        }catch(e){}
        return null;
      };
    }
  });
})();
