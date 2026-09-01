// SPDX-License-Identifier: GPL-3.0-or-later
// providers/arena.js - thin wrapper that loads the generic ZSProvider for arena.ai.
(function(){
  const G = window.__rolink_generic;
  if(!G) return;
  window.ZSProvider = Object.assign({}, G, { id: "arena", displayName: "Arena" });
})();
