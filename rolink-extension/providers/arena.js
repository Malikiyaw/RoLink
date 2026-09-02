// SPDX-License-Identifier: GPL-3.0-or-later
(function(){
  if(typeof window.makeGenericProvider !== "function") return;
  window.ZSProvider = window.makeGenericProvider({
    id:"arena", displayName:"Arena",
    selectors:{
      chatItem:"[data-testid*='message' i], [class*='message' i], [class*='response' i]",
      editor:"textarea, [contenteditable='true'], [role='textbox']",
      sendBtn:"button[aria-label*='Send' i], button[data-testid*='send' i], button[type='submit']"
    },
    augment:(P)=>{
      P.ensureComposerReady=async()=>{
        const selected=document.querySelector('[aria-selected="true"]')?.textContent||"";
        if(/battle|side[- ]?by[- ]?side|compare|arena/i.test(selected)) return {ready:false,reason:"Arena requires Direct mode."};
        return {ready:true};
      };
    }
  });
})();
