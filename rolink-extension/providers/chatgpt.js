// SPDX-License-Identifier: GPL-3.0-or-later
// providers/chatgpt.js - thin wrapper for chatgpt.com / chat.openai.com.
// ChatGPT is a textarea-based UI that matches the generic selectors well; we
// use the generic factory but mark it as Vision-capable.
(function(){
  if(typeof window.makeGenericProvider !== "function") return;
  const P = window.makeGenericProvider({
    id: "chatgpt",
    displayName: "ChatGPT",
  });
  window.ZSProvider = P;
})();
