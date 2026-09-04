// SPDX-License-Identifier: GPL-3.0-or-later
// providers/meta.js — Meta AI (meta.ai) provider.
//
// Meta AI quirks handled here:
//  - Large tool JSON renders in a viewer widget (.ur-code-block) with a
//    JSON / Tree / Raw toolbar. The Tree view ABRIDGES long values (shows
//    "[N items]" placeholders), so readText() flips command-shaped viewers to
//    their Raw tab once (tracked per node) and reads the verbatim <pre>.
//  - Non-viewer code still reads from the plain <pre>.
(function(){
  if(typeof window.makeGenericProvider !== "function") return;
  var _rawDone = new WeakSet();

  function isViewer(wrap){
    try{
      var t = (wrap.textContent || "").slice(0, 40);
      return /JSON/i.test(t) && /Tree/i.test(t) && /Raw/i.test(t) && !wrap.querySelector("pre");
    }catch(e){ return false; }
  }
  function ensureRawView(wrap){
    if(!wrap || _rawDone.has(wrap)) return;
    try{
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
  // Strip the toolbar prefix ("JSONTreeRaw") and clean a viewer dump into the
  // raw JSON the parser expects.
  function viewerJson(wrap){
    ensureRawView(wrap);
    try{
      var pre = wrap.querySelector("pre");
      if(pre) return pre.innerText || pre.textContent || "";
      var t = wrap.innerText || wrap.textContent || "";
      return t.replace(/^\s*JSON\s*Tree\s*Raw\s*/i, "");
    }catch(e){ return ""; }
  }

  window.ZSProvider = window.makeGenericProvider({
    id: "meta", displayName: "Meta AI",
    selectors: {
      chatItem: "[data-message-id], [class*='message' i], [class*='response' i], [role='article']",
      editor: "textarea, [contenteditable='true'], [role='textbox']",
      sendBtn: "button[aria-label*='Send' i], button[data-testid*='send' i], button[type='submit']"
    },
    readText: function(item){
      var out = [];
      var wraps = item.querySelectorAll ? item.querySelectorAll(".ur-code-block") : [];
      for(var i = 0; i < wraps.length; i++){
        var w = wraps[i];
        if(isViewer(w)) out.push(viewerJson(w));
        else {
          var pre = w.querySelector("pre");
          out.push(pre ? (pre.innerText || pre.textContent || "") : (w.innerText || w.textContent || ""));
        }
      }
      // Non-widget code blocks.
      var pres = item.querySelectorAll ? item.querySelectorAll("pre") : [];
      for(var j = 0; j < pres.length; j++){
        if(pres[j].closest && pres[j].closest(".ur-code-block")) continue;
        out.push(pres[j].innerText || pres[j].textContent || "");
      }
      out.push(item.innerText || item.textContent || "");
      return out.join("\n");
    },
    augment: function(P){
      // React recreates the widget subtree on stream settle: mark the stable
      // turn body so overlay.css keeps recreated viewers hidden (no flash).
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
