// SPDX-License-Identifier: GPL-3.0-or-later
// providers/gemini.js — Gemini (gemini.google.com) provider.
//
// Gemini quirks handled here:
//  - The composer is a Quill contenteditable (.ql-editor): typeAndSend writes
//    through a paste-shaped insert (ClipboardEvent / beforeinput) so Quill's
//    pipeline accepts multi-line payloads, instead of a raw text set that
//    Quill would split and renormalize line by line.
//  - The action button can WEDGE on its stop glyph after a generation ends:
//    isGenerating() treats a frozen stop glyph older than WEDGE_MS with no
//    stream growth as idle, and typeAndSend unwedges persistently before
//    sending so the arrow reappears.
//  - Large tool results are capped (120k chars / 1200 lines, head+tail with a
//    marker) so a big multi_edit result can still be pasted into Quill.
(function(){
  if(typeof window.makeGenericProvider !== "function") return;

  var SEND_MAX_CHARS = 120000;
  var SEND_MAX_LINES = 1200;

  function capLargeResult(text){
    if(!text) return text;
    var lines = String(text).split("\n");
    var overChars = text.length > SEND_MAX_CHARS;
    var overLines = lines.length > SEND_MAX_LINES;
    if(!overChars && !overLines) return text;
    var what = overChars ? (text.length + " chars") : (lines.length + " lines");
    var marker = "\n\n[…RoLink: result truncated (" + what + ") to fit Gemini's composer — " +
      "head + tail shown, work with these, do NOT re-run the command…]\n\n";
    var budget = SEND_MAX_CHARS - marker.length;
    var headLen = Math.floor(budget * 0.7);
    var tailLen = budget - headLen;
    return text.slice(0, headLen) + marker + text.slice(text.length - tailLen);
  }

  window.ZSProvider = window.makeGenericProvider({
    id: "gemini", displayName: "Gemini",
    selectors: {
      chatItem: "[data-message-id], message-content, [class*='message' i], [class*='response' i]",
      editor: ".ql-editor, textarea, [contenteditable='true']",
      sendBtn: "button[aria-label*='Send' i], button[data-testid*='send' i], button[type='submit']"
    },
    isTooLongMsg: function(t){ return /too long|context|maximum input|token limit/i.test(t || ""); },
    timings: { GEN_IDLE_MS: 1200, STABLE_MS: 5000, RESPONSE_TIMEOUT_MS: 300000 },
    augment: function(P){
      P.capResult = capLargeResult;
      // Roomy-composer feed cap: the core feeds results up to this size
      // (shaped by capResult above) instead of the default 12k context cap.
      P.feedCap = SEND_MAX_CHARS;
      // Stream-growth clock shared with the wedge check.
      var _max = -1, _at = 0, _item = null, _stopSince = 0;
      function sample(){
        var it = null;
        try{ it = P.lastAssistant ? P.lastAssistant() : null; }catch(e){}
        var len = 0;
        try{ len = P.streamLen ? P.streamLen(it) : 0; }catch(e){}
        var now = Date.now();
        if(it !== _item || len < _max - 400){ _item = it; _max = len; _at = now; return; }
        if(len > _max){ _max = len; _at = now; }
      }
      var WEDGE_MS = 10000;
      function stopGlyphOn(){
        try{
          var btns = document.querySelectorAll("button");
          for(var i = 0; i < btns.length; i++){
            var t = (btns[i].getAttribute("aria-label") || "") + " " + (btns[i].textContent || "");
            if(/stop/i.test(t) && btns[i].offsetParent !== null) return true;
          }
        }catch(e){}
        return false;
      }
      var baseGen = P.isGenerating;
      // Wedge-stop: a stop glyph frozen with zero stream growth for WEDGE_MS
      // is a stuck button, not a live generation.
      P.isGenerating = function(){
        sample();
        if(stopGlyphOn()){
          if(!_stopSince) _stopSince = Date.now();
          var growing = (_max > 1 && Date.now() - _at < WEDGE_MS);
          if(Date.now() - _stopSince > WEDGE_MS && !growing){ return false; }
          return true;
        }
        _stopSince = 0;
        return baseGen();
      };
      function sendButton(){
        try{
          var btns = document.querySelectorAll("button");
          for(var i = 0; i < btns.length; i++){
            var t = (btns[i].getAttribute("aria-label") || "") + " " + (btns[i].textContent || "");
            if(/send/i.test(t) && btns[i].offsetParent !== null &&
               btns[i].getAttribute("aria-disabled") !== "true") return btns[i];
          }
        }catch(e){}
        return null;
      }
      function unwedgeStop(){
        // Nudge the composer out of its frozen state: refocus + input pulse.
        try{
          var ed = P.getEditor ? P.getEditor() : null;
          if(!ed) return false;
          ed.focus();
          ed.dispatchEvent(new Event("input", { bubbles: true }));
          _stopSince = 0;
          return true;
        }catch(e){ return false; }
      }
      function waitFor(pred, ms){
        return new Promise(function(res){
          var t0 = Date.now();
          (function loop(){
            var ok = false;
            try{ ok = !!pred(); }catch(e){}
            if(ok) return res(true);
            if(Date.now() - t0 > ms) return res(false);
            setTimeout(loop, 80);
          })();
        });
      }
      // Quill paste-shaped insert: fires Quill's own pipeline instead of a
      // raw text set, so multi-line payloads survive intact.
      function quillInsert(ed, text){
        try{
          ed.focus();
          var sel = window.getSelection();
          if(sel && sel.rangeCount){
            try{ sel.removeAllRanges(); }catch(e){}
          }
          var ok = false;
          try{
            if(document.queryCommandSupported && document.queryCommandSupported("insertText")){
              ok = document.execCommand("insertText", false, text);
            }
          }catch(e){}
          if(!ok){
            try{
              ed.dispatchEvent(new InputEvent("beforeinput", {
                inputType: "insertFromPaste",
                data: text, bubbles: true, cancelable: true
              }));
            }catch(e){
              var dt = null;
              try{
                dt = new DataTransfer();
                dt.setData("text/plain", text);
              }catch(e2){}
              ed.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
            }
          }
          return true;
        }catch(e){ return false; }
      }
      var baseSend = P.typeAndSend;
      P.typeAndSend = function(text, images){
        text = capLargeResult(text);
        var ed = P.getEditor ? P.getEditor() : null;
        if(ed && ed.classList && ed.classList.contains("ql-editor")){
          quillInsert(ed, text);
          if(images && images.length && P.attachImages){
            return P.attachImages(images).then(function(){
              return sendAfterUnwedge();
            });
          }
          return sendAfterUnwedge();
        }
        return baseSend(text, images);
        function sendAfterUnwedge(){
          return (async function(){
            if(!sendButton()){
              unwedgeStop();
              await waitFor(sendButton, 4000);
            }
            var btn = sendButton();
            if(btn){ try{ btn.click(); }catch(e){} return; }
            var form = ed && ed.closest ? ed.closest("form") : null;
            if(form){ try{ form.requestSubmit(); }catch(e){} }
          })();
        }
      };
      var prevSpot = P.findToolBlockSpot;
      P.findToolBlockSpot = function(item, chip){
        if(!item) return null;
        try{
          var mc = item.querySelector ? (item.querySelector("message-content") || item.closest("message-content")) : null;
          if(mc) mc.classList.add("rl-cmd-mask");
          else if(item.classList) item.classList.add("rl-cmd-mask");
        }catch(e){}
        try{
          var r = prevSpot(item, chip);
          if(r && r.parent) return r;
        }catch(e){}
        return null;
      };
    }
  });
})();
