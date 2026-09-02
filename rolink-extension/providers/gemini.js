// SPDX-License-Identifier: GPL-3.0-or-later
(function(){
  if(typeof window.makeGenericProvider !== "function") return;
  window.ZSProvider = window.makeGenericProvider({
    id:"gemini", displayName:"Gemini",
    selectors:{
      chatItem:"[data-message-id], message-content, [class*='message' i], [class*='response' i]",
      editor:"textarea, [contenteditable='true'], .ql-editor",
      sendBtn:"button[aria-label*='Send' i], button[data-testid*='send' i], button[type='submit']"
    },
    isTooLongMsg:(t)=>/too long|context|maximum input|token limit/i.test(t||""),
    timings:{GEN_IDLE_MS:1200,STABLE_MS:5000,RESPONSE_TIMEOUT_MS:300000}
  });
})();
