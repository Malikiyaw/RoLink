// SPDX-License-Identifier: GPL-3.0-or-later
// providers/meta.js - thin wrapper that loads the generic ZSProvider for meta.ai.
(function(){
  const G = window.__rolink_generic;
  if(!G) return;
  window.ZSProvider = Object.assign({}, G, { id: "meta", displayName: "Meta AI" });
})();
