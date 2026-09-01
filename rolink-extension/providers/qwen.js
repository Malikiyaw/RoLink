// SPDX-License-Identifier: GPL-3.0-or-later
// providers/qwen.js - thin wrapper for chat.qwen.ai.
// Uses the network SSE tap (qwen-net.js) for reliable per-turn detection.
(function(){
  if(typeof window.makeGenericProvider !== "function") return;
  window.ZSProvider = window.makeGenericProvider({
    id: "qwen",
    displayName: "Qwen",
  });
})();
