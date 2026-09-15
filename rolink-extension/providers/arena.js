// SPDX-License-Identifier: GPL-3.0-or-later
// providers/arena.js — Arena (arena.ai, lmarena.ai) provider.
//
// Supported modes: Direct (1 model) + Agent Mode (/agent multi-step runs).
// Blocked: Battle / Side-by-Side (a comparison turn has no single reply to
// parse or feed — ensureComposerReady refuses those, never Agent).
//
// Agent Mode quirks handled here:
//  - Mode detect: combo text (direct|battle|agent|side by side) + /agent
//    path + Agent DOM markers (plan steps, task runs, file-attach dropzone).
//    isAgentMode() is the single check; arenaMode() returns
//    direct|agent|battle|side-by-side|unknown.
//  - Agent replies render as multi-step traces (plan nodes, collapsed step
//    trees), not one chat bubble — readAssistant prefers the latest settled
//    step node and falls back to the generic last-assistant read.
//  - Agent runs take longer — sends are send-until-clear (bounded ~12s) and
//    generation detection also honors aria-busy / progress markers.
//  - restoreDirectOnce() only ever flips Battle/Side-by-Side back to Direct
//    on a fresh page (once per load). It NEVER flips Agent Mode away.
(function(){
  if(typeof window.makeGenericProvider !== "function") return;
  window.ZSProvider = window.makeGenericProvider({
    id: "arena", displayName: "Arena",
    selectors: {
      chatItem: "[data-testid*='message' i], [data-testid*='agent-step' i], [data-testid*='task' i], [data-testid*='plan' i], [class*='message' i], [class*='response' i]",
      editor: "textarea, [contenteditable='true'], [role='textbox']",
      sendBtn: "button[aria-label*='Send' i], button[data-testid*='send' i], button[type='submit']"
    },
    augment: function(P){
      var MODE_RE = /\b(direct|battle|agent|side[\s_-]?by[\s_-]?side)\b/i;
      var BLOCKED_RE = /battle|side[\s_-]?by[\s_-]?side/i;
      function comboText(){
        try{
          var el = document.querySelector("[class*='mode' i] button, [class*='conversation-mode' i], [role='combobox']");
          return ((el && (el.textContent || "")) || "").trim();
        }catch(e){ return ""; }
      }
      function pathMode(){
        try{
          var p = (location && location.pathname) || "";
          if(/\/agent\b/i.test(p)) return "agent";
        }catch(e){}
        return "";
      }
      function agentDomPresent(){
        try{
          if(typeof document === "undefined" || !document.querySelector) return false;
          return !!(document.querySelector(
            "[data-testid*='agent' i], [data-testid*='plan-step' i], [data-testid*='task-run' i]," +
            " [data-dropzone], [class*='agent-plan' i], [class*='task-trace' i]"
          ));
        }catch(e){ return false; }
      }
      P.arenaMode = function(){
        var pm = pathMode();
        if(pm) return pm;
        var m = null;
        try{ m = comboText().match(MODE_RE); }catch(e){}
        if(m){
          var v = m[1].toLowerCase().replace(/[\s_-]+/g, " ");
          if(/^side/.test(v)) return "side-by-side";
          return v;
        }
        if(agentDomPresent()) return "agent";
        return "unknown";
      };
      P.isAgentMode = function(){
        try{ return P.arenaMode() === "agent"; }catch(e){ return false; }
      };
      // Gate: refuse Battle / Side-by-Side only. Direct + Agent + unknown pass.
      var prevReady = P.ensureComposerReady;
      P.ensureComposerReady = function(reason){
        var mode = "unknown";
        try{ mode = P.arenaMode(); }catch(e){}
        if(mode && BLOCKED_RE.test(mode)){
          return Promise.resolve({ ready: false, reason: "Arena requires Direct or Agent Mode (1 task) — Battle / Side-by-Side have no single reply to drive." });
        }
        return prevReady(reason);
      };
      // One-shot restore: flip a fresh Battle/Side-by-Side page back to
      // Direct once per load. Never touches Agent Mode; never re-fires on a
      // sweep, so a deliberate user switch later is respected.
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
          // Agent Mode is first-class: never flip it away.
          if(mode === "agent") return res(false);
          if(/direct/i.test(mode || "") || mode === "unknown") {
            // Only auto-restore when visibly stuck on a comparison mode.
            if(!BLOCKED_RE.test(mode || "")) return res(false);
          }
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
      // Agent-aware generation: generic stop-button/stream check first, then
      // Agent busy markers (aria-busy, progress, plan-step streaming).
      // No-DOM safe: every access guarded, returns false without a document.
      var baseGenerating = P.isGenerating;
      var baseHard = P.isHardGenerating;
      function agentBusy(){
        try{
          if(typeof document === "undefined" || !document.querySelector) return false;
          var busy = document.querySelector(
            "[data-testid*='agent' i][aria-busy='true'], [data-testid*='plan-step' i][aria-busy='true']," +
            " [aria-busy='true'].rl-agent-scope, main progress, [role='progressbar']"
          );
          return !!busy;
        }catch(e){ return false; }
      }
      P.isGenerating = function(){
        try{ if(baseGenerating && baseGenerating()) return true; }catch(e){}
        return agentBusy();
      };
      P.isHardGenerating = function(){
        try{ if(baseHard && baseHard()) return true; }catch(e){}
        return agentBusy();
      };
      // Agent-aware read: prefer the latest settled plan-step/task node so a
      // multi-step trace feeds one ###MCP_TOOL### per turn; fall back to the
      // generic last-assistant read. Never throws without DOM.
      var baseRead = P.readAssistant;
      P.readAssistant = function(){
        try{
          if(P.isAgentMode() && typeof document !== "undefined" && document.querySelectorAll){
            var steps = document.querySelectorAll(
              "[data-testid*='plan-step' i], [data-testid*='task-run' i], [data-testid*='agent-step' i]"
            );
            for(var i = steps.length - 1; i >= 0; i--){
              var el = steps[i];
              var busy = false;
              try{ busy = el.getAttribute && el.getAttribute("aria-busy") === "true"; }catch(e){}
              if(busy) continue;
              var txt = "";
              try{ txt = (el.innerText || el.textContent) || ""; }catch(e){}
              if(txt && txt.trim().length > 5) return { present: true, reply: txt, thinking: "", item: el };
            }
          }
        }catch(e){}
        try{ return baseRead(); }catch(err){ return { present: false, reply: "", thinking: "", item: null }; }
      };
      // Send-until-clear: re-click until the editor empties or generation
      // starts (bounded ~12s for slower Agent runs), so one swallowed click
      // never drops a result.
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
              if(Date.now() - t0 > 12000) return res(false);
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
          // Agent traces may nest the tool block inside a collapsed step —
          // expand the step path first so the generic marker scan can see it.
          if(P.isAgentMode()){
            try{
              var host = item.closest ? item.closest("[data-testid*='plan-step' i], details, [aria-expanded='false']") : null;
              if(host && host.getAttribute && host.getAttribute("aria-expanded") === "false"){
                var toggle = host.querySelector("button, summary, [role='button']");
                if(toggle && toggle.click) toggle.click();
              }
            }catch(e){}
          }
          var r = prevSpot(item, chip);
          if(r && r.parent) return r;
        }catch(e){}
        return null;
      };
    }
  });
})();

