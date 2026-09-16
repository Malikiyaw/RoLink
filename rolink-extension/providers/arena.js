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
      chatItem: "[data-testid*='message' i], [data-testid*='agent-step' i], [data-testid*='task' i], [data-testid*='plan' i], [data-testid*='run' i], [data-testid*='step' i], [class*='message' i], [class*='response' i], [class*='turn' i]",
      editor: "textarea, [contenteditable='true'], [role='textbox']",
      sendBtn: "button[aria-label*='Send' i], button[data-testid*='send' i], button[type='submit']"
    },
    // Volatile chrome on the Agent page: thought-duration counters, progress
    // bars and live status regions tick inside observed replies and would
    // defeat the loop's text-stability gate (see generic stripVolatile).
    // LMArena variants render elapsed-time footers and streaming status lines;
    // strip those too so payload stability (not chrome churn) gates execution.
    volatileSel: "[data-testid*='thought' i], [class*='thought' i], [data-testid*='timer' i], [class*='timer' i], [data-testid*='elapsed' i], [class*='elapsed' i], [data-testid*='duration' i], [class*='duration' i], [data-testid*='status' i][class*='live' i], [class*='progress' i], [class*='streaming' i], [role='progressbar'], [aria-live='polite'][class*='status' i]",
    // Agent tasks die fast (the platform may rate/end the task seconds after
    // the model stops), so settle thresholds run tighter here than on
    // persistent chats. Direct-chat providers keep generic defaults.
    timings: { STABLE_MS: 5000, BLOCK_SETTLE_MS: 1500, BLOCK_GEN_GRACE_MS: 1000 },
    augment: function(P){
      var MODE_RE = /\b(direct|battle|agent|side[\s_-]?by[\s_-]?side)\b/i;
      var BLOCKED_RE = /battle|side[\s_-]?by[\s_-]?side/i;
      function comboText(){
        try{
          var el = document.querySelector("[class*='mode' i] button, [class*='conversation-mode' i], [role='combobox'], [data-testid*='mode' i], [aria-label*='mode' i]");
          var t = ((el && (el.textContent || "")) || "").trim();
          if(t) return t;
          // Fallback: checked radio / selected option in a mode switcher.
          var checked = document.querySelector("[role='radiogroup'] [aria-checked='true'], [data-testid*='mode'] [aria-selected='true']");
          return ((checked && (checked.textContent || "")) || "").trim();
        }catch(e){ return ""; }
      }
      function pathMode(){
        try{
          var p = (location && location.pathname) || "";
          if(/\/agent\b/i.test(p)) return "agent";
          // Hash routers (#/agent), locale prefixes (/en/agent), query (?mode=agent).
          var h = (location && location.hash) || "";
          if(/agent/i.test(h)) return "agent";
          var s = (location && location.search) || "";
          if(/[?&](mode|view|tab)=agent\b/i.test(s)) return "agent";
          if(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?agent\b/i.test(p)) return "agent";
          // Markup-driven: an explicit agent root marker anywhere on the page.
          if(typeof document !== "undefined" && document.querySelector){
            if(document.querySelector("[data-mode='agent' i], [data-view='agent' i], main[data-agent]")) return "agent";
          }
        }catch(e){}
        return "";
      }
      function agentDomPresent(){
        try{
          if(typeof document === "undefined" || !document.querySelector) return false;
          return !!(document.querySelector(
            "[data-testid*='agent' i], [data-testid*='plan-step' i], [data-testid*='task-run' i]," +
            " [data-testid*='run-step' i], [data-testid*='tool-call' i]," +
            " [data-dropzone], [class*='agent-plan' i], [class*='task-trace' i]," +
            " [class*='agent-timeline' i], [class*='run-timeline' i], main [class*='agent' i]"
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
      // Agent-aware read: join ALL settled plan-step/task nodes in document
      // order so tool blocks split across sibling steps are never dropped;
      // single-step traces behave exactly as before. When the step join has
      // no tool signature, escalate: turn-container read, then fence-direct
      // extraction (virtualized code nodes), then a bounded page scan — so a
      // VISIBLE block is always found even with unknown lmarena/arena node
      // types. Falls back to the generic last-assistant read. Never throws.
      var baseRead = P.readAssistant;
      function fenceTexts(root){
        // Direct textContent pull from pre/code descendants: virtualized
        // fences render placeholders via innerText while full JSON sits in
        // the DOM. Returns concatenated texts not already covered.
        var out = [];
        try{
          if(!root || !root.querySelectorAll) return out;
          var nodes = root.querySelectorAll("pre, code");
          for(var k = 0; k < nodes.length; k++){
            var t = "";
            try{ t = nodes[k].textContent || ""; }catch(e){}
            if(t && t.length > 20) out.push(t);
          }
        }catch(e){}
        return out;
      }
      function hasSig(s){
        try{
          if(typeof ZSParse !== "undefined" && ZSParse.hasToolSignature) return ZSParse.hasToolSignature(s);
        }catch(e){}
        return (s || "").indexOf("###MCP_TOOL###") !== -1;
      }
      P.readAssistant = function(){
        try{
          if(P.isAgentMode() && typeof document !== "undefined" && document.querySelectorAll){
            var steps = document.querySelectorAll(
              "[data-testid*='plan-step' i], [data-testid*='task-run' i], [data-testid*='agent-step' i]," +
              " [data-testid*='run-step' i], [data-testid*='tool-call' i]"
            );
            if(steps && steps.length){
              var parts = [];
              var lastEl = null;
              for(var i = 0; i < steps.length; i++){
                var el = steps[i];
                var busy = false;
                try{ busy = el.getAttribute && el.getAttribute("aria-busy") === "true"; }catch(e){}
                if(busy) continue;
                var txt = "";
                try{ txt = (el.innerText || el.textContent) || ""; }catch(e){}
                // Strip volatile descendants (thought timers) so the loop's
                // stability gate sees content, not ticking chrome.
                try{
                  if(P.stripVolatile){
                    var st = P.stripVolatile(el);
                    if(st != null && st.trim() !== "") txt = st;
                  }
                }catch(e){}
                // Clipped-fence fallback: virtualized code nodes render a
                // placeholder via innerText while full JSON sits collapsed.
                try{
                  if(typeof ZSParse !== "undefined" && ZSParse.hasToolSignature && ZSParse.stableBlockKey){
                    if(ZSParse.hasToolSignature(txt) && !ZSParse.stableBlockKey(txt)){
                      var ft = "";
                      try{ ft = el.textContent || ""; }catch(ee){}
                      if(ft && ft.length > txt.length && ZSParse.stableBlockKey(ft)) txt = ft;
                    }
                  }
                }catch(e){}
                // Fence-direct pull: append pre/code textContent missing from
                // the visible read (virtualized fences).
                try{
                  var fts = fenceTexts(el);
                  for(var fi = 0; fi < fts.length; fi++){
                    if(txt.indexOf(fts[fi].slice(0, 40)) === -1) txt += "\n" + fts[fi];
                  }
                }catch(e){}
                if(txt && txt.trim().length > 5){ parts.push(txt); lastEl = el; }
              }
              var joined = parts.length ? parts.join("\n\n") : "";
              if(joined && hasSig(joined)) return { present: true, reply: joined, thinking: "", item: lastEl };
              // Escalation 1: turn-container read — climb from the last step
              // to the enclosing turn and read the whole subtree (unknown
              // wrapper node types live here).
              try{
                var anchor = lastEl || steps[steps.length - 1];
                var host = (anchor && anchor.closest) ? anchor.closest("article, [data-testid*='turn' i], [data-testid*='message' i], [class*='turn' i], li") : null;
                if(host){
                  var ht = "";
                  try{ ht = (host.innerText || host.textContent) || ""; }catch(e){}
                  try{
                    if(P.stripVolatile){
                      var hst = P.stripVolatile(host);
                      if(hst != null && hst.trim() !== "") ht = hst;
                    }
                  }catch(e){}
                  try{
                    var hfts = fenceTexts(host);
                    for(var hi = 0; hi < hfts.length; hi++){
                      if(ht.indexOf(hfts[hi].slice(0, 40)) === -1) ht += "\n" + hfts[hi];
                    }
                  }catch(e){}
                  if(ht && hasSig(ht)) return { present: true, reply: ht, thinking: "", item: host };
                }
              }catch(e){}
              // Escalation 2: bounded page scan — find any visible marker
              // text node under main and return its enclosing block.
              try{
                var scope = null;
                try{ scope = document.querySelector("main") || document.body; }catch(e){ scope = null; }
                if(scope && document.createTreeWalker && typeof NodeFilter !== "undefined"){
                  var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
                  var n = null, found = null, guard = 0;
                  while((n = walker.nextNode()) && guard++ < 4000){
                    var v = "";
                    try{ v = n.nodeValue || ""; }catch(e){}
                    if(v.length > 8 && v.length < 200000 && hasSig(v)){ found = n.parentElement; break; }
                  }
                  if(found){
                    var blk = found;
                    try{
                      while(blk && blk.parentElement && blk.parentElement !== scope &&
                            !/^(PRE|CODE|DIV|P|LI|ARTICLE)$/.test(blk.tagName)) blk = blk.parentElement;
                    }catch(e){}
                    var bt = "";
                    try{ bt = (blk.innerText || blk.textContent) || ""; }catch(e){}
                    if(bt && hasSig(bt)) return { present: true, reply: bt, thinking: "", item: blk };
                  }
                }
              }catch(e){}
              // Steps existed but hold no block yet — return the joined text
              // (may be thought/progress) so generation tracking stays honest.
              if(joined) return { present: true, reply: joined, thinking: "", item: lastEl };
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
              " [data-testid*='task-input' i], [data-testid*='prompt-input' i], [data-testid*='composer-input' i]," +
              " [data-testid*='agent-input' i], [data-testid*='chat-input' i], form textarea, main textarea"
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

