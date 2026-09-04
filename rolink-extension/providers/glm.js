// SPDX-License-Identifier: GPL-3.0-or-later
// providers/glm.js — GLM (chat.z.ai) provider.
//
// GLM quirk handled here: the composer is a React-driven <textarea>. Setting
// .value directly never reaches React's model — the send fires with an empty
// box. typeAndSend therefore writes through the NATIVE
// HTMLTextAreaElement.prototype.value setter plus input/change events so
// React's onChange fires and the send carries the real text.
(function(){
  if(typeof window.makeGenericProvider !== "function") return;
  window.ZSProvider = window.makeGenericProvider({
    id: "glm", displayName: "GLM",
    selectors: {
      chatItem: "[data-message-id], [data-testid*='message' i], [class*='message' i], [class*='chat' i]",
      editor: "textarea, [contenteditable='true'], [role='textbox']",
      sendBtn: "button[aria-label*='Send' i], button[data-testid*='send' i], button[type='submit']"
    },
    isTooLongMsg: function(t){ return /too long|context|token limit|maximum/i.test(t || ""); },
    augment: function(P){
      function setNativeTextarea(el, v){
        try{
          var proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
          var desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
          if(desc && desc.set) desc.set.call(el, v);
          else el.value = v;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }catch(e){
          try{ el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); return true; }catch(e2){ return false; }
        }
      }
      var baseSend = P.typeAndSend;
      P.typeAndSend = function(text, images){
        var ed = P.getEditor ? P.getEditor() : null;
        if(ed && ed.tagName === "TEXTAREA"){
          try{ ed.focus(); }catch(e){}
          setNativeTextarea(ed, text);
          // Give React a tick to flush the controlled value, attach images,
          // then click send directly (baseSend would re-set — and wipe — text).
          return new Promise(function(res){ setTimeout(res, 150); }).then(function(){
            if(images && images.length && P.attachImages){
              return P.attachImages(images);
            }
            return true;
          }).then(function(){
            var btn = null;
            try{
              var btns = document.querySelectorAll("button[aria-label*='Send' i], button[data-testid*='send' i], button[type='submit']");
              for(var i = 0; i < btns.length; i++){
                if(btns[i].offsetParent !== null && btns[i].getAttribute("aria-disabled") !== "true"){ btn = btns[i]; break; }
              }
            }catch(e){}
            if(btn){ try{ btn.click(); }catch(e){} return; }
            var form = ed.closest ? ed.closest("form") : null;
            if(form){ try{ form.requestSubmit(); }catch(e){ form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); } }
          });
        }
        return baseSend(text, images);
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
