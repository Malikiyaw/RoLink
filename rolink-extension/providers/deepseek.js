// SPDX-License-Identifier: GPL-3.0-or-later
// providers/deepseek.js - DeepSeek (chat.deepseek.com) provider.
// Implements the ZSProvider interface used by core/main.js. EVERYTHING that
// knows DeepSeek's DOM, quirks and UI strings lives here.
//
// Validation strategy: selectors prefer DeepSeek's stable "ds-" design system
// classes; where DeepSeek ships hashed CSS-module names (e.g. `d29f3d7d`) we
// fall back to behavioral detection (button glyph, textarea presence).
/* eslint-disable no-unused-vars */
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init({diag})

  const S = {
    chatItem: ".ds-message",
    userMod: "d29f3d7d",
    userBubble: ".fbb737a4",
    box: ".ds-markdown",
    editor: "textarea",
    msgEditBox: ".ds-textarea",
    thinking: ".ds-think-content",
    markdown: ".ds-markdown",
    generating: ".ds-loading",
    sendBtn: ".ds-button--primary",
    stopBtn: ".ds-button--primary",
    errorSurfaces: '[class*="ds-toast"],[class*="toast"],[class*="error"],[class*="alert"],[class*="warning"],[class*="modal"],[role="alert"]',
    modeRadioGroup: '[role="radiogroup"]',
    modeRadio: '[role="radio"]',
  };

  const RE = {
    contextLimit: /(conversation.{0,20}(too long|trop long)|context.{0,20}(limit|exceeded)|session.{0,20}(expired)|please.{0,30}(start).{0,20}(new).{0,20}(chat)|(token|context).{0,10}limit|message.{0,20}too.{0,10}long|maximum.{0,20}context|this conversation has reached)/i,
    tooLong: /conversation .{0,20}(too long|getting too long)/i,
    continueBtn: /^(continue|continuer|继续(生成)?|fortfahren|continuar|seguir|続行)$/i,
    stopped: /(arrêté|arrété|stopped|已停止|停止生成|已暂停)/i,
    expertMode: /expert|专家|专业/i,
    instantMode: /instant|rapide|快速/i,
    visionMode: /vision|视觉|图像|多模态/i,
  };

  const timings = {
    GEN_IDLE_MS: 800,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  function isUserItem(item) {
    if (!item) return false;
    if (S.userMod && item.classList.contains(S.userMod)) return true;
    if (S.userBubble && item.querySelector(S.userBubble)) return true;
    return false;
  }
  const isAssistantItem = (item) => !!item && !isUserItem(item);

  function itemText(item) {
    if (isAssistantItem(item)) {
      const mds = [...item.querySelectorAll(S.markdown)].filter((m) => !m.closest(S.thinking));
      return mds.map((m) => m.textContent).join("\n");
    }
    return item.textContent || "";
  }

  const allItems = () => [...document.querySelectorAll(S.chatItem)];
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;

  // Get the SITE's composer (skip our own UI)
  const getEditor = () => {
    const site = [...document.querySelectorAll(S.editor)].filter((e) => !e.closest("#rl-root"));
    return site.find((e) => !e.closest(S.msgEditBox)) || site[0] || null;
  };
  const editorText = () => {
    const e = getEditor();
    if (!e) return "";
    return (e.value != null ? e.value : e.textContent || "");
  };

  // Lock the user textarea during agent activity.
  function setInputLock(on) {
    const ed = getEditor();
    if (!ed) return;
    if (on) {
      if (!ed.dataset.rlPlaceholder) ed.dataset.rlPlaceholder = ed.getAttribute("placeholder") || "";
      ed.setAttribute("readonly", "");
      ed.setAttribute("placeholder", "RoLink agent working, please wait...");
    } else {
      ed.removeAttribute("readonly");
      if (ed.dataset.rlPlaceholder != null) ed.setAttribute("placeholder", ed.dataset.rlPlaceholder);
    }
  }

  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  // Stable per-turn identity (DeepSeek virtualizes the message list; counts
  // can be wrong when old turns detach). Use the parent's data-virtual-list-
  // item-key, which IS stable. Fall back to a positional index.
  function itemKey(item) {
    if (!item) return null;
    const p = item.parentElement;
    const k = p && p.getAttribute("data-virtual-list-item-key");
    if (k != null) return "ds:" + k;
    // fallback: index in the assistant list
    const i = assistantItems().indexOf(item);
    return i >= 0 ? "ds:idx:" + i : null;
  }
  function lastAssistantId() { return itemKey(lastAssistant()); }
  function itemIdByIndex(idx) { const a = assistantItems(); return a[idx] ? itemKey(a[idx]) : null; }

  const chatIsEmpty = () => allItems().length === 0;
  const isFreshChat = () => chatIsEmpty() && !!document.querySelector(S.modeRadioGroup);

  function composerFrame() {
    const ta = getEditor();
    if (!ta) return null;
    const sb = document.querySelector(S.sendBtn);
    let n = ta;
    for (let i = 0; i < 14 && n && n.parentElement; i++) {
      if (!sb || n.contains(sb)) return n;
      n = n.parentElement;
    }
    let f = ta;
    for (let i = 0; i < 6 && f.parentElement; i++) f = f.parentElement;
    return f;
  }

  // Where to mount the in-page bar (above the composer)
  function barMount() {
    const ta = getEditor();
    if (!ta) return null;
    const send = document.querySelector(S.sendBtn);
    let box = ta.parentElement;
    while (box && box !== document.body) {
      if (!send || box.contains(send)) break;
      box = box.parentElement;
    }
    if (!box || box === document.body) box = ta.parentElement;
    if (!box) return null;
    let before = box.firstElementChild;
    if (before && before.id === "rl-bar") before = before.nextElementSibling;
    return { parent: box, before, inside: true };
  }

  // --- DeepSeek's footer button doubles as SEND (arrow) and STOP (square).
  // Old: stop glyph = <rect>.  V4: both are <path>; stop's d starts with M2 / M3
  // (top-left corner of the square), send's starts with M8 (mid-glyph arrow).
  function isStopBtn(btn) {
    if (!btn) return false;
    if (btn.querySelector("rect")) return true;
    const p = btn.querySelector("path");
    if (!p) return false;
    return /^\s*M\s*[0-3][\s.]/.test(p.getAttribute("d") || "");
  }

  // Stream growth tracking (only signal during the reasoning phase when there
  // is NO stop button and NO spinner).
  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function streamText(item) {
    if (!item) return "";
    const think = item.querySelector(S.thinking);
    const thinkTxt = think ? think.textContent || "" : "";
    const replyTxt = [...item.querySelectorAll(S.markdown)]
      .filter((m) => !m.closest(S.thinking) && !m.closest(".rl-chip"))
      .map((m) => m.textContent).join("");
    return thinkTxt + "\n" + replyTxt;
  }
  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;
  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    if (item !== _streamItem || len < _streamMax - 400) { _streamItem = item; _streamMax = len; _streamAt = now; return; }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; }
  }
  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  function reasoningInProgress(item) {
    if (!item) return false;
    const think = item.querySelector(S.thinking);
    const thinkTxt = think ? (think.textContent || "") : "";
    if (!thinkTxt.trim().length) return false;
    const replyLen = [...item.querySelectorAll(S.markdown)]
      .filter((m) => !m.closest(S.thinking) && !m.closest(".rl-chip"))
      .reduce((n, m) => n + (m.textContent || "").length, 0);
    if (replyLen !== 0) return false;
    if (turnHalted(item)) return false;
    return true;
  }
  function turnHalted(item) {
    if (!item) return false;
    const think = item.querySelector(S.thinking);
    const thinkTxt = think ? (think.textContent || "") : "";
    return RE.stopped.test(item.textContent || "") && !RE.stopped.test(thinkTxt);
  }
  function isGenerating() {
    if (document.querySelector(S.generating)) return true;
    const btn = document.querySelector(S.sendBtn);
    if (isStopBtn(btn)) return true;
    sampleStream();
    if (reasoningInProgress(lastAssistant())) return grewWithin(timings.REASON_IDLE_MS);
    return grewWithin(timings.GEN_IDLE_MS);
  }
  function isBusyNow() {
    if (document.querySelector(S.generating)) return true;
    const btn = document.querySelector(S.sendBtn);
    if (isStopBtn(btn)) return true;
    sampleStream();
    if (!reasoningInProgress(lastAssistant())) return false;
    return grewWithin(timings.REASON_IDLE_MS);
  }
  function isHardGenerating() { return isStopBtn(document.querySelector(S.sendBtn)); }
  function genDebug() {
    try {
      sampleStream();
      const btn = document.querySelector(S.sendBtn);
      const path = btn && btn.querySelector("path");
      const rp = btn && btn.querySelector("rect");
      return {
        spinner: !!document.querySelector(S.generating),
        stopBtn: isStopBtn(btn),
        btnGlyph: rp ? "rect" : (path ? (path.getAttribute("d") || "").slice(0,6) : "none"),
        reasoning: reasoningInProgress(lastAssistant()),
        streamMax: _streamMax, streamAgeMs: _streamAt ? Date.now()-_streamAt : -1,
        grewGen: grewWithin(timings.GEN_IDLE_MS),
        grewReason: grewWithin(timings.REASON_IDLE_MS),
        gen: isGenerating(),
      };
    } catch (e) { return { err: String(e && e.message || e) }; }
  }
  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      const th = it.querySelector(S.thinking);
      const rp = [...it.querySelectorAll(S.markdown)]
        .filter((m) => !m.closest(S.thinking) && !m.closest(".rl-chip"))
        .reduce((n, m) => n + (m.textContent || "").length, 0);
      return { th: th ? (th.textContent || "").trim().length : 0, rp };
    } catch { return {}; }
  }
  function findContinueBtn() {
    for (const b of document.querySelectorAll(".ds-button")) {
      if (b.offsetParent === null) continue;
      if (RE.continueBtn.test((b.innerText || "").trim())) return b;
    }
    return null;
  }
  function clickContinueBtn() {
    const b = findContinueBtn();
    if (!b) return false;
    try { b.click(); return true; } catch { return false; }
  }
  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const mds = [...item.querySelectorAll(S.markdown)].filter((m) => !m.closest(S.thinking));
    return {
      present: true,
      reply: mds.map((m) => m.textContent).join("\n").trim(),
      thinking: "",
      item,
    };
  }

  // --- Sending. DeepSeek's composer is a <textarea> driven by React; we must
  // set .value via the native prototype setter so React's onChange fires.
  function setTextareaValue(el, v) {
    const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function pressEnter(editor) {
    const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    editor.dispatchEvent(new KeyboardEvent("keydown", o));
    editor.dispatchEvent(new KeyboardEvent("keyup", o));
  }
  function clickSendButton() {
    if (isBusyNow()) return false;
    const btn = document.querySelector(S.sendBtn);
    if (btn && !isStopBtn(btn) && btn.getAttribute("aria-disabled") !== "true") {
      btn.click();
      return true;
    }
    return false;
  }

  // DeepSeek's composer caps input at 163840 chars (validated live 2026-07-22).
  // Anything over it silently blocks the send. Truncate with a head+tail marker
  // so the model knows the gap and doesn't retry the whole call.
  const SEND_CAP = 163840, SEND_MAX = 160000;
  function truncateForSend(text) {
    if (!text || text.length <= SEND_MAX) return text;
    const omitted = text.length - SEND_MAX;
    const marker = `\n\n[…RoLink: result truncated to fit DeepSeek's ${SEND_CAP}-character input limit - ${omitted} of ${text.length} characters omitted. Do NOT re-run the command; work with the head and tail shown here…]\n\n`;
    const budget = SEND_MAX - marker.length;
    const headLen = Math.floor(budget * 0.85);
    const tailLen = budget - headLen;
    return text.slice(0, headLen) + marker + text.slice(text.length - tailLen);
  }

  async function typeAndSend(text, images) {
    const editor = getEditor();
    if (!editor) throw new Error("DeepSeek input box not found");
    editor.focus();
    text = truncateForSend(text);
    setTextareaValue(editor, text);
    const hasImages = !!(images && images.length);
    if (hasImages) {
      const ok = await attachImages(images);
      if (!ok) { clearAttachments(); }
      // Poll-click the send arrow (NOT the stop square) until the editor clears
      // or the generation starts. Self-correcting, no DOM dependency.
      const t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        const btn = document.querySelector(S.sendBtn);
        if (btn && !isStopBtn(btn) && btn.getAttribute("aria-disabled") !== "true") {
          try { btn.click(); } catch {}
        }
        if (await new Promise(r => { const t0=Date.now(); (function loop(){ if(editorText().trim()===""||isHardGenerating()) return r(true); if(Date.now()-t0>1200) return r(false); setTimeout(loop,80); })(); })) return;
      }
      return;
    }
    await new Promise(r => { const t0=Date.now(); (function loop(){ const btn=document.querySelector(S.sendBtn); if(btn && btn.getAttribute("aria-disabled")!=="true" && !isStopBtn(btn)) return r(true); if(Date.now()-t0>800) return r(false); setTimeout(loop,80); })(); });
    if (!clickSendButton() && !isBusyNow()) pressEnter(editor);
  }
  function stopGeneration() {
    const b = document.querySelector(S.stopBtn);
    if (isStopBtn(b)) try { b.click(); } catch {}
  }

  // --- Image attachment (file input -> real upload; paste -> local preview fallback)
  function fileFromImage(img, i) {
    const mime = img.mimeType || "image/jpeg";
    const bin = atob(img.data);
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    const ext = mime.includes("png") ? "png" : "jpg";
    return new File([arr], `rolink_${Date.now()}_${i}.${ext}`, { type: mime });
  }
  // Pending uploads are blob: <img> not inside a chat message
  const attachThumbs = () => {
    try {
      return [...document.querySelectorAll("img")].filter(
        (im) => !im.closest(S.chatItem) &&
          (/^blob:/.test(im.getAttribute("src") || "") || /^rolink_/.test(im.getAttribute("alt") || "")));
    } catch { return []; }
  };
  function clearAttachments() {
    try {
      document.querySelectorAll('[class*="delete" i], [class*="close" i], [class*="remove" i]')
        .forEach((d) => {
          if (d.closest(S.chatItem)) return;
          ["mouseover","mousedown","mouseup","click"].forEach((t) => {
            try { d.dispatchEvent(new MouseEvent(t, { bubbles: true })); } catch {}
          });
        });
    } catch {}
  }
  async function attachImages(images) {
    const editor = getEditor();
    if (!editor || !images || !images.length) return false;
    if (attachThumbs().length > 0) return true; // idempotent
    const want = images.length;
    const dt = new DataTransfer();
    images.forEach((img, i) => { try { dt.items.add(fileFromImage(img, i)); } catch {} });
    if (!dt.items.length) return false;
    editor.focus();
    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
      try { fileInput.files = dt.files; fileInput.dispatchEvent(new Event("change", { bubbles: true })); } catch {}
    } else {
      editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      if (attachThumbs().length >= want) return true;
      await sleep(150);
    }
    return attachThumbs().length > 0;
  }

  function scanError() {
    try {
      for (const el of document.querySelectorAll(S.errorSurfaces)) {
        if (el.offsetParent === null) continue;
        if (el.closest(S.chatItem)) continue;
        const t = (el.innerText || "").trim();
        if (t.length > 8 && t.length < 600 && RE.contextLimit.test(t)) return t.slice(0, 240);
      }
    } catch {}
    if (!getEditor()) return "The input box disappeared (session ended?).";
    return null;
  }
  const isTooLongMsg = (text) => RE.tooLong.test(text);

  // --- Composer mode (Expert/Instant/Vision) — drive once at session start
  const nodeText = (n) => (n && (n.innerText || n.textContent || "").trim()) || "";
  const radioOn = (r) => !!r && r.getAttribute("aria-checked") === "true";
  function findModeRadio(type) {
    const group = document.querySelector(S.modeRadioGroup);
    const radios = group ? [...group.querySelectorAll(S.modeRadio)] : [...document.querySelectorAll(S.modeRadio)];
    return radios.find((r) => r.getAttribute("data-model-type") === type) || null;
  }
  const findExpertRadio = () => findModeRadio("expert");
  const findVisionRadio = () => findModeRadio("vision");
  const findInstantRadio = () => findModeRadio("default");

  // Vision detection: latched from the radio while visible, otherwise from the
  // conversation header badge.
  let _visLatch = false, _visLatchSet = false, _visAt = 0, _visCache = false;
  function badgeVision() {
    const els = [...document.querySelectorAll("div,span")].filter(
      (e) => e.childElementCount === 0 && /^(instant|expert|vision)$/i.test((e.textContent || "").trim()) && e.getBoundingClientRect().width > 0);
    if (!els.length) return null;
    els.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return /vision/i.test(els[0].textContent || "");
  }
  function detectVision() {
    const now = Date.now();
    if (now - _visAt < 400) return _visCache;
    _visAt = now;
    const group = document.querySelector(S.modeRadioGroup);
    if (group) {
      const v = findVisionRadio();
      if (v) { _visLatch = radioOn(v); _visLatchSet = true; return (_visCache = _visLatch); }
    }
    const b = badgeVision();
    if (b != null) { _visLatch = b; _visLatchSet = true; return (_visCache = b); }
    if (_visLatchSet) return (_visCache = _visLatch);
    return (_visCache = false);
  }
  const isVisionSelected = () => detectVision();

  function enforceComposer(reason) {
    if (!reason) return composerModeState();
    try {
      // Force Expert unless user explicitly chose Vision/Instant
      if (!isVisionSelected() && !radioOn(findInstantRadio())) {
        const expert = findExpertRadio();
        if (expert && expert.getAttribute("aria-checked") !== "true") {
          try { expert.click(); } catch {}
        }
      }
      return composerModeState();
    } catch { return composerModeState(); }
  }
  function composerModeState() {
    const expert = findExpertRadio();
    const vision = findVisionRadio();
    const instant = findInstantRadio();
    return {
      expertFound: !!expert, expertOn: radioOn(expert),
      visionFound: !!vision, visionOn: radioOn(vision),
      instantFound: !!instant, instantOn: radioOn(instant),
    };
  }
  async function ensureComposerReady(reason) {
    let state = composerModeState();
    for (let i = 0; i < 12; i++) {
      state = enforceComposer(reason);
      if (state.expertOn || state.visionOn || state.instantOn) break;
      await sleep(120);
    }
    state = composerModeState();
    return { ...state, ready: state.expertOn || state.visionOn || state.instantOn };
  }

  // Conversation key (latch "started" to the chat)
  const conversationKey = () => (location.pathname === "/" ? "" : location.pathname);

  // Core uniformity hooks (same surface as the generic factory):
  //  - capResult/feedCap: DeepSeek's composer takes ~160k chars (truncateForSend
  //    head+tails there), so the core may feed up to 60k shaped head+tail here
  //    instead of the default 12k context cap. 60k stays well under the composer
  //    limit, so the send-side truncation never fires on our own feeds.
  const DS_FEED_MAX = 60000, DS_FEED_LINES = 600;
  const capResult = (t) => {
    if (!t) return t;
    const lines = String(t).split("\n");
    if (t.length <= DS_FEED_MAX && lines.length <= DS_FEED_LINES) return t;
    const what = t.length > DS_FEED_MAX ? (t.length + " chars") : (lines.length + " lines");
    const marker = `\n\n[…RoLink: result truncated (${what}) to fit the feed budget — head + tail shown, do NOT re-run the command…]\n\n`;
    const budget = DS_FEED_MAX - marker.length;
    const headLen = Math.floor(budget * 0.7), tailLen = budget - headLen;
    return t.slice(0, headLen) + marker + t.slice(t.length - tailLen);
  };
  const feedCap = DS_FEED_MAX;
  //  - overlayBlocking: DeepSeek has no login/modal mask over the composer.
  const overlayBlocking = () => false;
  //  - replyUnsettled: still-streaming reasoning/answer means a tool-shaped
  //    turn may still be growing — hold it open.
  function replyUnsettled(item) {
    try {
      if (isGenerating()) return true;
      const it = item || lastAssistant();
      if (it && reasoningInProgress(it)) return grewWithin(timings.REASON_IDLE_MS);
    } catch {}
    return false;
  }
  //  - hasStreamingLabel: a {"tool":|"command": name matched BEFORE its
  //    closing quote exists — the turn is tool-shaped mid-stream.
  const STREAM_LABEL_RE = /"(?:command|tool)"\s*:\s*"([^"]*)/;
  const hasStreamingLabel = (t) => STREAM_LABEL_RE.test(t || "");

  // Send hooks (intercept user input so we can react to manual sends)
  function installSendHooks(handlers) {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      const editor = getEditor();
      if (!editor || !editor.contains(e.target)) return;
      const text = editorText().trim();
      if (!text) return;
      if (handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (!chatIsEmpty()) return;
        handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);
    document.addEventListener("click", (e) => {
      if (!getEditor()) return;
      const t = e.target;
      const cont = t && t.closest && t.closest(".ds-button");
      if (cont && RE.continueBtn.test((cont.innerText || "").trim())) {
        handlers.onNativeContinue(); return;
      }
      const btn = t && t.closest && t.closest(S.sendBtn);
      if (!btn) return;
      if (isStopBtn(btn)) { handlers.onNativeStop(); return; }
      if (btn.getAttribute("aria-disabled") === "true") return;
      if (handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (!chatIsEmpty()) return;
        handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);
  }

  // Hide the raw tool block before inserting the chip (camouflage)
  function findToolBlockSpot(item, chip) {
    const containers = [...item.querySelectorAll(S.markdown)].filter((m) => !m.closest(S.thinking));
    if (!containers.length) return null;
    let parent = null, ref = null;
    for (const container of containers) {
      const kids = [...container.children].filter((k) => k !== chip && !(chip && k.contains(chip)));
      for (let i = 0; i < kids.length; i++) {
        const txt = (kids[i].textContent || "");
        const tLow = txt.toLowerCase();
        // Accept every shape parser.js extractAll handles: MCP marker, LUA
        // marker, TOOL-scoped blocks, fenced lua/json, and bare JSON envelopes
        // {"tool":...} / {"command":...}. A block the parser sees but the
        // spotter misses falls back to body-insert (invisible chip).
        const isStart = tLow.includes("###mcp_tool###") || tLow.includes("###lua###") || tLow.includes("###tool:")
          || tLow.includes("```lua") || tLow.includes("```json")
          || /"(tool|command)"\s*:\s*"/i.test(txt);
        if (!isStart) continue;
        let runEnd = i;
        if (tLow.includes("###mcp_tool###")) {
          let j = i; let depth = 0;
          for (; j < kids.length; j++) {
            const tt = (kids[j].textContent || "");
            for (const c of tt) { if (c === "{") depth++; else if (c === "}") depth--; }
            if (depth <= 0) { runEnd = j; break; }
            runEnd = j;
          }
        } else if (tLow.includes("###lua###") || tLow.includes("```lua")) {
          let j = i + 1;
          for (; j < kids.length; j++) {
            const tt = (kids[j].textContent || "").toLowerCase();
            if (tt.includes("###end_lua###") || /^\s*```/.test(tt)) { runEnd = j; break; }
            runEnd = j;
          }
        } else if (tLow.includes("```json")) {
          let j = i + 1;
          for (; j < kids.length; j++) {
            const tt = (kids[j].textContent || "");
            if (tt.includes("```")) { runEnd = j; break; }
            runEnd = j;
          }
        }
        for (let k = i; k <= runEnd; k++) {
          let hide = kids[k];
          const wrap = hide.closest("[class*='code']");
          if (wrap && container.contains(wrap) && wrap !== container) hide = wrap;
          hide.classList.add("rl-tool-hide");
          if (!ref && hide.parentElement) { parent = hide.parentElement; ref = hide; }
        }
        i = runEnd;
      }
    }
    return ref ? { parent, ref } : null;
  }

  return {
    id: "deepseek",
    displayName: "DeepSeek",
    get supportsVision() { return isVisionSelected(); },
    timings,
    thinkingSel: S.thinking,
    init({ diag: d } = {}) { if (d) diag = d; },
    allItems, isUserItem, isAssistantItem, itemText, classifyText: itemText,
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
    capResult, feedCap, overlayBlocking, replyUnsettled, hasStreamingLabel,
  };
})();

window.ZSProvider = ZSProvider;
