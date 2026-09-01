// SPDX-License-Identifier: GPL-3.0-or-later
// providers/glm.js - thin wrapper for chat.z.ai.
(function(){
  if(typeof window.makeGenericProvider !== "function") return;
  window.ZSProvider = window.makeGenericProvider({
    id: "glm",
    displayName: "GLM",
  });
})();
