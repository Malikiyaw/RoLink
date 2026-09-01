// SPDX-License-Identifier: GPL-3.0-or-later
// providers/gemini.js - thin wrapper that loads the generic ZSProvider for gemini.google.com.
(function(){
  const G = window.__rolink_generic;
  if(!G) return;
  // Just set the displayName + SELF id
  G.id = "gemini"; G.displayName = "Gemini";
  // Patch SELF inside the closure so itemKey() etc. produce "gemini:..." ids.
  // (We can't reassign the const SELF in the IIFE, so we wrap.)
  window.ZSProvider = Object.assign({}, G, { id: "gemini", displayName: "Gemini" });
})();
