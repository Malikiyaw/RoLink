// SPDX-License-Identifier: GPL-3.0-or-later
// providers/kimi.js - thin wrapper for kimi.ai.
(function(){
  if(typeof window.makeGenericProvider !== "function") return;
  window.ZSProvider = window.makeGenericProvider({
    id: "kimi",
    displayName: "Kimi",
  });
})();
