// SPDX-License-Identifier: GPL-3.0-or-later
// providers/meta.js - thin wrapper for meta.ai.
(function(){
  if(typeof window.makeGenericProvider !== "function") return;
  window.ZSProvider = window.makeGenericProvider({
    id: "meta",
    displayName: "Meta AI",
  });
})();
