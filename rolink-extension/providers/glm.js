// SPDX-License-Identifier: GPL-3.0-or-later
// providers/glm.js - thin wrapper that loads the generic ZSProvider for chat.z.ai.
(function(){
  const G = window.__rolink_generic;
  if(!G) return;
  window.ZSProvider = Object.assign({}, G, { id: "glm", displayName: "GLM" });
})();
