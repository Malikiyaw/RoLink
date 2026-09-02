// SPDX-License-Identifier: GPL-3.0-or-later
(function(){
  if(typeof window.makeGenericProvider !== "function") return;
  window.ZSProvider = window.makeGenericProvider({
    id:"qwen", displayName:"Qwen",
    selectors:{
      chatItem:"[data-message-id], [class*='message' i], [class*='response' i]",
      editor:"textarea, [contenteditable='true'], [role='textbox']",
      sendBtn:"button[aria-label*='Send' i], button[data-testid*='send' i], button[type='submit']"
    },
    isTooLongMsg:(t)=>/too long|context|token limit|maximum/i.test(t||"")
  });
})();
