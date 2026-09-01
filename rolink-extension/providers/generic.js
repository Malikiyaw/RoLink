// SPDX-License-Identifier: GPL-3.0-or-later
// providers/generic.js - a "good enough" generic ZSProvider for any AI chat site.
// Used by the lighter providers (gemini, kimi, glm, qwen, arena, meta).
// Site-specific quirks can be added per-provider later; this handles the 80%
// of cases (textarea / contenteditable + send button + per-message author
// attribute, falling back to last-block-of-text).
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let diag = () => {};
  let SELF = "generic";

  const S = {
    chatItem: "[data-message-author-role], [data-testid*='conversation-turn'], article, .message, [class*='message' i][class*='turn' i], main p",
    editor: "textarea, [contenteditable='true']",
    sendBtn: "button[data-testid*='send' i], button[aria-label*='Send' i], button[aria-label*='Submit' i], form button[type='submit']",
  };
  const timings = { GEN_IDLE_MS: 1000, REASON_IDLE_MS: 15000, WARMUP_MS: 30000, REASON_NOREPLY_MS: 60000, STABLE_MS: 7000, RESPONSE_TIMEOUT_MS: 300000 };

  const allItems = () => [...document.querySelectorAll(S.chatItem)].filter(it => {
    // ignore text nodes and micro-elements
    return it && (it.innerText || "").length > 5 && (it.querySelector("p, div") || it.tagName === "ARTICLE" || it.tagName === "DIV");
  });
  const isUser = (it) => it && (it.getAttribute && (it.getAttribute("data-message-author-role") === "user" || it.getAttribute("data-author") === "user" || /user|human/i.test(it.className||"")));
  const isAssistant = (it) => it && !isUser(it);
  const assistantItems = () => allItems().filter(isAssistant);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUser).length;
  const lastAssistant = () => { const a = assistantItems(); return a.length ? a[a.length-1] : null; };
  const getEditor = () => [...document.querySelectorAll(S.editor)].filter(e => !e.closest("#rl-root") && e.offsetParent !== null)[0] || null;
  const editorText = () => { const e = getEditor(); return e ? (e.value != null ? e.value : e.textContent || "") : ""; };
  const chatIsEmpty = () => allItems().length === 0;
  const itemKey = (it) => { if(!it) return null; const id = it.getAttribute("data-message-id") || it.getAttribute("data-id") || it.getAttribute("data-turn-id") || it.id; if(id) return SELF+":"+id; const i = assistantItems().indexOf(it); return i>=0 ? SELF+":idx:"+i : null; };
  const lastAssistantId = () => itemKey(lastAssistant());
  const itemIdByIndex = (i) => { const a = assistantItems(); return a[i] ? itemKey(a[i]) : null; };
  const composerFrame = () => { const t = getEditor(); if(!t) return null; let n = t; for(let i=0;i<14 && n.parentElement;i++){ const btn = document.querySelector(S.sendBtn); if(!btn || n.contains(btn)) return n; n = n.parentElement; } let f=t; for(let i=0;i<6;i++) f=f.parentElement||f; return f; };
  const barMount = () => { const t = getEditor(); if(!t) return null; let b = t.parentElement; while(b && b !== document.body){ if(b.contains(document.querySelector(S.sendBtn))) break; b = b.parentElement; } if(!b||b===document.body) b = t.parentElement; if(!b) return null; let before = b.firstElementChild; if(before && before.id === "rl-bar") before = before.nextElementSibling; return {parent: b, before, inside: true}; };
  function setInputLock(on){ const ed = getEditor(); if(!ed) return; if(on){ if(!ed.dataset.rlPlaceholder) ed.dataset.rlPlaceholder = ed.getAttribute("placeholder") || ""; ed.setAttribute("readonly",""); ed.setAttribute("placeholder","RoLink agent working, please wait..."); } else { ed.removeAttribute("readonly"); if(ed.dataset.rlPlaceholder != null) ed.setAttribute("placeholder", ed.dataset.rlPlaceholder); } }
  const streamLen = (it) => { const i = it || lastAssistant(); return i ? (i.innerText || "").length : 0; };
  const snapshot = () => { const it = lastAssistant(); return it ? {th:0, rp: (it.innerText||"").length} : {th:0, rp:0}; };
  function isStopBtn(btn){ if(!btn) return false; if(btn.querySelector("rect")) return true; const p = btn.querySelector("path"); return p ? /^\s*M\s*[0-3][\s.]/.test(p.getAttribute("d")||"") : false; }
  // Generic isGenerating: stream grew within 1.2s
  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream(){ const it = lastAssistant(); if(!it){ _streamItem=null; _streamMax=-1; return; } const len = streamLen(it); const now = Date.now(); if(it !== _streamItem || len < _streamMax - 400){ _streamItem = it; _streamMax = len; _streamAt = now; return; } if(len > _streamMax){ _streamMax = len; _streamAt = now; } }
  function isGenerating(){ const btn = document.querySelector(S.sendBtn); if(isStopBtn(btn)) return true; sampleStream(); return _streamMax > 1 && Date.now() - _streamAt < 1200; }
  function isBusyNow(){ return isGenerating(); }
  function isHardGenerating(){ return isStopBtn(document.querySelector(S.sendBtn)); }
  function genDebug(){ return {gen: isGenerating()}; }
  function findContinueBtn(){ for(const b of document.querySelectorAll("button")){ if(b.offsetParent===null) continue; if(/^(continue|continuar|continu)/i.test((b.innerText||"").trim())) return b; } return null; }
  function clickContinueBtn(){ const b=findContinueBtn(); if(b){try{b.click();return true;}catch{}} return false; }
  function readAssistant(){ const i = lastAssistant(); return {present: !!i, reply: i?i.innerText||"":"", thinking:"", item:i}; }
  function turnHalted(){ return false; }
  function setReact(el, v){ const p = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLDivElement.prototype; const s = Object.getOwnPropertyDescriptor(p,"value")?.set; if(s){s.call(el,v); el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true}));} else { el.value=v; el.dispatchEvent(new Event("input",{bubbles:true})); } }
  async function typeAndSend(text, images){ const e = getEditor(); if(!e) throw new Error("no input box"); e.focus(); setReact(e, text); await sleep(200); const btn = document.querySelector(S.sendBtn); if(btn && !isStopBtn(btn) && btn.getAttribute("aria-disabled") !== "true"){ try{btn.click();}catch{} return; } const form = e.closest("form"); if(form){ try{form.requestSubmit();}catch{form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));} } }
  function stopGeneration(){ const b = document.querySelector(S.sendBtn); if(isStopBtn(b)) try{b.click();}catch{} }
  function scanError(){ if(!getEditor()) return "Input box gone."; return null; }
  const isTooLongMsg = (t) => /too long|context.{0,10}limit|maximum.{0,20}context/i.test(t);
  const attachImages = async () => false;
  const clearAttachments = () => {};
  const conversationKey = () => location.pathname;
  const enforceComposer = () => ({});
  const ensureComposerReady = async () => ({ready: true});
  const findToolBlockSpot = (item, chip) => { if(!item) return null; const md = item.querySelector("p, div"); return md ? {parent: md.parentElement, ref: md} : null; };
  function installSendHooks(handlers){ /* omitted for v1.2 generic stub */ }
  function isFreshChat(){ return chatIsEmpty(); }
  return {
    id: SELF, displayName: SELF,
    get supportsVision(){ return true; },
    timings, init({diag:d}={}){ if(d) diag=d; },
    allItems, isUserItem: isUser, isAssistantItem: isAssistant, itemText: i => i?(i.innerText||""):"",
    classifyText: i => i?(i.innerText||""):"",
    assistantCount, userCount, lastAssistant, lastAssistantId, itemIdByIndex, itemKey, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, barMount,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating, genDebug,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg,
    attachImages, clearAttachments, conversationKey,
    installSendHooks, findToolBlockSpot,
  };
})();
// Expose the generic provider for thin per-site wrappers to layer over.
window.__rolink_generic = ZSProvider;
