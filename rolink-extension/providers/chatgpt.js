// SPDX-License-Identifier: GPL-3.0-or-later
(function(){
  if(typeof window.makeGenericProvider !== "function") return;
  window.ZSProvider = window.makeGenericProvider({
    id:"chatgpt", displayName:"ChatGPT",
    selectors:{
      chatItem:"[data-message-author-role], [data-testid*='conversation-turn'], main article",
      editor:"textarea, div[contenteditable='true']",
      sendBtn:"button[data-testid='send-button'], button[aria-label*='Send' i], form button[type='submit']"
    },
    readText:(item)=>{
      const code=item.querySelector("pre code, pre, .whitespace-pre-wrap");
      return code ? (code.innerText||code.textContent||"") + "\n" + (item.innerText||"") : (item.innerText||"");
    },
    isTooLongMsg:(t)=>/too long|context window|maximum context|message too long/i.test(t||"")
  });
})();
