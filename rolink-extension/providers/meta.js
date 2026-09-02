// SPDX-License-Identifier: GPL-3.0-or-later
(function(){
  if(typeof window.makeGenericProvider !== "function") return;
  window.ZSProvider = window.makeGenericProvider({
    id:"meta", displayName:"Meta AI",
    selectors:{
      chatItem:"[data-message-id], [class*='message' i], [class*='response' i], [role='article']",
      editor:"textarea, [contenteditable='true'], [role='textbox']",
      sendBtn:"button[aria-label*='Send' i], button[data-testid*='send' i], button[type='submit']"
    },
    readText:(item)=>{
      const raw=item.querySelector("pre code, pre");
      return raw ? (raw.innerText||raw.textContent||"") : (item.innerText||"");
    }
  });
})();
