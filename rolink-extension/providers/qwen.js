// SPDX-License-Identifier: GPL-3.0-or-later
// providers/qwen.js - thin wrapper that loads the generic ZSProvider for chat.qwen.ai.
// Qwen uses a network SSE stream; for v1.2 the generic DOM-based provider works for
// most flows. A network-tap variant (qwen-net.js) can be added later for full parity.
(function(){
  const G = window.__rolink_generic;
  if(!G) return;
  window.ZSProvider = Object.assign({}, G, { id: "qwen", displayName: "Qwen" });
})();
