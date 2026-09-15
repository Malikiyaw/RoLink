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
//  - Agent composer send is hardened: the Agent page composer differs from
//    Direct chat, and a silent no-op send stranded the loop ("did not accept
//    the injected message"). Agent sends use insert-verify (execCommand
//    insertText + beforeinput for contenteditable, React-aware value set for
//    textarea — aborting the attempt when text never lands) plus a send
//    cascade (Agent submit button -> generic send button -> form submit ->
//    synthetic Enter) with per-leg reporting on P.lastSendLeg.
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
          if(busy) return true;
          // A visible Stop control (outside our own bar) means a task is running.
          var stops = [];
          try{ stops = document.querySelectorAll("button[data-testid*='stop' i], button[aria-label*='Stop' i]"); }catch(e){}
          for(var i = 0; i < stops.length; i++){
            try{ if(stops[i].offsetParent !== null && !stops[i].closest("#rl-root")) return true; }catch(e){}
          }
          return false;
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
      // Agent-hardened send. Direct chat keeps the generic path; the Agent
      // page gets a local implementation: agent-first editor resolution,
      // kind-aware insert with verification, and a send cascade that never
      // silently no-ops. Contract with main.js: always resolves boolean,
      // never throws. The leg that fired is on P.lastSendLeg.
      var baseSend = P.typeAndSend;
      P.lastSendLeg = null;
      function agentEditor(){
        try{
          if(P.isAgentMode() && typeof document !== "undefined" && document.querySelectorAll){
            var cands = document.querySelectorAll(
              "[data-testid*='agent-composer' i] textarea, [data-testid*='agent-composer' i] [contenteditable='true']," +
              " [data-testid*='task-input' i], [data-testid*='prompt-input' i], [data-testid*='composer-input' i]"
            );
            for(var i = 0; i < cands.length; i++){
              var c = cands[i];
              try{ if(c && !c.closest("#rl-root") && c.isConnected) return c; }catch(e){ return c; }
            }
          }
        }catch(e){}
        try{ return P.getEditor ? P.getEditor() : null; }catch(err){ return null; }
      }
      function editorContent(ed){
        try{ return (ed.value != null ? ed.value : ed.textContent) || ""; }catch(e){ return ""; }
      }
      function isEditable(el){
        try{ return !!el.isContentEditable || (el.getAttribute && el.getAttribute("contenteditable") === "true"); }catch(e){ return false; }
      }
      function insertText(ed, text){
        try{
          if(isEditable(ed)){
            try{ ed.focus(); }catch(e){}
            var done = false;
            try{
              if(document.queryCommandSupported && document.queryCommandSupported("insertText"))
                done = document.execCommand("insertText", false, text);
            }catch(e){}
            if(!done){
              try{ ed.dispatchEvent(new InputEvent("beforeinput", {inputType: "insertText", data: text, bubbles: true, cancelable: true})); }catch(e){}
              try{
                var sel = (window.getSelection && window.getSelection()) || null;
                if(sel && sel.rangeCount){ sel.deleteContents(); sel.getRangeAt(0).insertNode(document.createTextNode(text)); }
                else { ed.textContent = (ed.textContent || "") + text; }
              }catch(e){ try{ ed.textContent = text; }catch(err){} }
              try{ ed.dispatchEvent(new InputEvent("input", {inputType: "insertText", data: text, bubbles: true})); }catch(e){}
              try{ ed.dispatchEvent(new Event("input", {bubbles: true})); }catch(e){}
            }
          } else {
            // textarea/input: React-aware value set (native setter + events).
            try{
              var proto = ed.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              var desc = Object.getOwnPropertyDescriptor(proto, "value");
              if(desc && desc.set) desc.set.call(ed, text);
              else ed.value = text;
            }catch(e){ try{ ed.value = text; }catch(err){} }
            try{ ed.dispatchEvent(new Event("input", {bubbles: true})); }catch(e){}
            try{ ed.dispatchEvent(new Event("change", {bubbles: true})); }catch(e){}
          }
        }catch(e){}
      }
      function isStopBtn(btn){
        if(!btn || !btn.querySelector) return false;
        try{
          if(btn.querySelector("rect")) return true;
          var p = btn.querySelector("path");
          return p ? /^\s*M\s*[0-3][\s.]/.test(p.getAttribute("d") || "") : false;
        }catch(e){ return false; }
      }
      function clickIfSendable(btn){
        try{
          if(!btn || btn.getAttribute("aria-disabled") === "true") return false;
          if(btn.offsetParent === null && !btn.isConnected) return false;
          if(isStopBtn(btn)) return false;
          btn.click();
          return true;
        }catch(e){ return false; }
      }
      function fireSendCascade(ed, skipEnter){
        var leg = null;
        // Leg 1: Agent submit button.
        try{
          var cands = document.querySelectorAll(
            "[data-testid*='agent' i] button[type='submit']," +
            " [data-testid*='task-send' i], [data-testid*='prompt-send' i]," +
            " [data-testid*='composer-send' i], button[aria-label*='Start task' i]"
          );
          for(var i = 0; i < cands.length && !leg; i++){
            if(clickIfSendable(cands[i])) leg = "agent-btn";
          }
        }catch(e){}
        // Leg 2: generic send button.
        if(!leg){
          try{
            var btns = document.querySelectorAll("button[aria-label*='Send' i], button[data-testid*='send' i], button[type='submit']");
            for(var j = 0; j < btns.length && !leg; j++){
              if(clickIfSendable(btns[j])) leg = "send-btn";
            }
          }catch(e){}
        }
        // Leg 3: enclosing form submit.
        if(!leg){
          try{
            var form = ed && ed.closest ? ed.closest("form") : null;
            if(form){
              try{ form.requestSubmit(); }catch(e){ try{ form.dispatchEvent(new Event("submit", {bubbles: true, cancelable: true})); }catch(err){} }
              leg = "form";
            }
          }catch(e){}
        }
        // Leg 4: synthetic Enter on the editor (once per send, never spammed).
        if(!leg && !skipEnter){
          try{
            var o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
            ed.dispatchEvent(new KeyboardEvent("keydown", o));
            ed.dispatchEvent(new KeyboardEvent("keyup", o));
            leg = "enter";
          }catch(e){}
        }
        try{ P.lastSendLeg = leg; }catch(e){}
        return leg;
      }
      function waitClear(ms, skipEnterOnRetry){
        return new Promise(function(res){
          var t0 = Date.now();
          (function loop(){
            var ed = null;
            try{ ed = agentEditor(); }catch(e){}
            var empty = !ed || (editorContent(ed).trim() === "");
            var gen = false;
            try{ gen = P.isGenerating && P.isGenerating(); }catch(e){}
            if(empty || gen) return res(true);
            if(Date.now() - t0 > ms) return res(false);
            // Retry buttons/form only — Enter fires once per send attempt.
            try{ if(ed) fireSendCascade(ed, skipEnterOnRetry); }catch(e){}
            setTimeout(loop, 400);
          })();
        });
      }
      // One-line composer diagnosis for the Activity feed when a send fails:
      // mode + editor kind/visibility + send controls + last leg. No-DOM safe.
      P.describeComposer = function(){
        try{
          var mode = P.arenaMode();
          if(typeof document === "undefined" || !document.querySelectorAll) return "mode=" + mode + " (no DOM)";
          var ed = null;
          try{ ed = agentEditor(); }catch(e){}
          var edDesc = !ed ? "editor=none"
            : "editor=" + String((ed.tagName || "?")).toLowerCase() +
              (isEditable(ed) ? "[ce]" : "") + "(vis=" + (ed.offsetParent !== null) + ")";
          var btns = [];
          try{ btns = document.querySelectorAll("button[aria-label*='Send' i], button[data-testid*='send' i], [data-testid*='composer-send' i], [data-testid*='task-send' i]"); }catch(e){}
          var vis = 0, k;
          for(k = 0; k < btns.length; k++){ try{ if(btns[k].offsetParent !== null) vis++; }catch(e){} }
          return "mode=" + mode + " " + edDesc + " sendBtns=" + vis + "/" + btns.length + " leg=" + (P.lastSendLeg || "none");
        }catch(e){ return "composer=?"; }
      };
      P.typeAndSend = function(text, images){
        var agent = false;
        try{ agent = P.isAgentMode(); }catch(e){}
        if(!agent){
          // Direct chat: unchanged path + send-until-clear.
          return baseSend(text, images).then(function(){ return waitClear(12000, true); });
        }
        // Agent page: full local send (images N/A on the greeting path).
        return new Promise(function(res){
          try{
            if(typeof document === "undefined") return res(false);
            var ed = agentEditor();
            if(!ed) return res(false);
            try{ ed.focus(); }catch(e){}
            insertText(ed, text);
            // Verify the text actually landed before touching send — a dead
            // insert is what used to burn all 4 attempts silently.
            var probe = String(text).slice(0, 24);
            if(editorContent(ed).indexOf(probe) === -1) return res(false);
            fireSendCascade(ed, false);
            waitClear(12000, true).then(res);
          }catch(e){ res(false); }
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

