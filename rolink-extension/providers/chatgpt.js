// SPDX-License-Identifier: GPL-3.0-or-later
// providers/chatgpt.js — ChatGPT (chatgpt.com) provider.
//
// ChatGPT quirks handled here:
//  - Fenced code renders through a virtualized code view that truncates long
//    lines in the DOM. providers/chatgpt-cm.js (MAIN world) republishes each
//    block's TRUE document into a data-rl-cm attribute; readText() syncs it
//    first, then prefers the attribute over the rendered lines.
//  - React re-creates <pre> nodes on every token: per-element hide classes get
//    wiped mid-stream, so findToolBlockSpot() also marks the stable .markdown
//    container with .rl-cmd-mask, and overlay.css keeps every recreated <pre>
//    hidden under that mask (no raw-JSON flash).
//  - The composer is a rounded-corner card; the bar claims its full-width
//    header row (see overlay.css .rl-prov-chatgpt) so it never collapses the
//    input or gets sliced by the card's overflow clip.
(function(){
  if(typeof window.makeGenericProvider !== "function") return;

  // Ask the MAIN-world tap to refresh true-document attributes, then read.
  function syncTrueDocs(){
    try{ document.dispatchEvent(new CustomEvent("rl-cm-sync")); }catch(e){}
  }
  function trueDocText(pre){
    if(!pre) return "";
    // The attribute lives on the .cm-content node inside the <pre>.
    var host = (pre.classList && pre.classList.contains("cm-content"))
      ? pre
      : (pre.querySelector ? pre.querySelector(".cm-content[data-rl-cm]") : null);
    if(host){
      var v = host.getAttribute("data-rl-cm");
      if(typeof v === "string" && v.length) return v;
    }
    return "";
  }
  function renderedLines(pre){
    var lines = pre.querySelectorAll ? pre.querySelectorAll(".cm-line") : [];
    if(lines.length){
      var out = [];
      for(var i = 0; i < lines.length; i++) out.push(lines[i].textContent || "");
      return out.join("\n");
    }
    return pre.textContent || "";
  }
  function codeText(pre){
    var full = trueDocText(pre);
    if(full) return full;
    return renderedLines(pre);
  }

  window.ZSProvider = window.makeGenericProvider({
    id: "chatgpt", displayName: "ChatGPT",
    selectors: {
      chatItem: "[data-message-author-role], [data-testid*='conversation-turn'], main article",
      editor: "textarea, div[contenteditable='true']",
      sendBtn: "button[data-testid='send-button'], button[aria-label*='Send' i], form button[type='submit']"
    },
    readText: function(item){
      syncTrueDocs();
      var out = [];
      var pres = item.querySelectorAll ? item.querySelectorAll("pre") : [];
      for(var i = 0; i < pres.length; i++) out.push(codeText(pres[i]));
      var rest = (item.innerText || item.textContent || "");
      out.push(rest);
      return out.join("\n");
    },
    isTooLongMsg: function(t){ return /too long|context window|maximum context|message too long/i.test(t || ""); },
    augment: function(P){
      P.trueDocText = codeText;
      // A modal (login / dialog) above the composer: park the bar so it never
      // covers a button the user must click.
      P.overlayBlocking = function(){
        try{
          var m = document.querySelector("[role='dialog'], [data-testid*='modal' i]");
          return !!(m && m.offsetParent !== null);
        }catch(e){ return false; }
      };
      // Hide the bar's own row from text reads (own UI must never parse).
      var prevSpot = P.findToolBlockSpot;
      P.findToolBlockSpot = function(item, chip){
        if(!item) return null;
        try{
          var md = item.querySelector ? item.querySelector(".markdown") : null;
          if(md) md.classList.add("rl-cmd-mask");
        }catch(e){}
        if(typeof prevSpot === "function"){
          try{
            var r = prevSpot(item, chip);
            if(r && r.parent) return r;
          }catch(e){}
        }
        // Marker-aware fallback: find the first text node carrying a tool
        // opener and anchor the chip right before its block.
        try{
          var walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
          var n;
          while((n = walker.nextNode())){
            var v = n.nodeValue || "";
            var low = v.toLowerCase();
            if(low.indexOf("###mcp_tool###") !== -1 || low.indexOf("###lua###") !== -1 ||
               low.indexOf("###tool:") !== -1 || /"(tool|command)"\s*:\s*"/i.test(v)){
              var host = n.parentElement;
              while(host && host.parentElement && host.parentElement !== item &&
                    !/^(PRE|CODE|DIV|P)$/.test(host.tagName)) host = host.parentElement;
              if(host && host.parentElement){
                host.classList.add("rl-tool-hide");
                return { parent: host.parentElement, ref: host };
              }
            }
          }
        }catch(e){}
        return null;
      };
    }
  });
  try{ window.ZSProvider.provClass = "rl-prov-chatgpt"; }catch(e){}
})();
