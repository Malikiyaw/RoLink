// SPDX-License-Identifier: GPL-3.0-or-later
// providers/gemini.js - thin wrapper that builds the generic ZSProvider for gemini.google.com.
(function(){
  if(typeof window.makeGenericProvider !== "function") return;
  window.ZSProvider = window.makeGenericProvider({
    id: "gemini",
    displayName: "Gemini",
  });
})();
