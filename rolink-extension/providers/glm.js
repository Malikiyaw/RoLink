// SPDX-License-Identifier: GPL-3.0-or-later
(function(){
  if(typeof window.makeGenericProvider !== "function") return;
  window.ZSProvider = window.makeGenericProvider({
    id:"glm", displayName:"GLM",
    selectors:{
      chatItem:"[data-message-id], [data-testid*='message' i], [class*='message' i], [class*='chat' i]",
      editor:"textarea, [contenteditable='true'], [role='textbox']",
      sendBtn:"button[aria-label*='Send' i], button[data-testid*='send' i], button[type='submit']"
    },
    isTooLongMsg:(t)=>/too long|context|token limit|maximum/i.test(t||"")
  });
})();
