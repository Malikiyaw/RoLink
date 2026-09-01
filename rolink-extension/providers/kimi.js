// SPDX-License-Identifier: GPL-3.0-or-later
// providers/kimi.js - thin wrapper that loads the generic ZSProvider for kimi.ai.
(function(){
  const G = window.__rolink_generic;
  if(!G) return;
  window.ZSProvider = Object.assign({}, G, { id: "kimi", displayName: "Kimi" });
})();
