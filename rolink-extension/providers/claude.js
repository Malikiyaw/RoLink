// SPDX-License-Identifier: GPL-3.0-or-later
// providers/claude.js - Claude (claude.ai) provider.
//
// Built on the generic factory (providers/generic.js must load BEFORE this
// file in manifest.json) plus an `augment` patch for Claude-specific pieces.
// Status: fresh support, NOT yet live-validated - every selector below is
// layered with fallbacks and fails open (degrade to waiting, never a wrong
// action). A live-DOM validation pass is required before dropping the
// unstable pill (see the LIVE-DOM notes inline).
//
// Known Claude surface (to verify live): React app, routes /new and
// /chat/<id>, contenteditable composer, extended-thinking blocks, code
// artifacts in a side panel. RoLink commands must be plain-text JSON in the
// CHAT - never inside an artifact (artifacts don't reflow into turns).
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";

  const isShown = (e) => { try { return e.getClientRects().length > 0; } catch { return false; } };
  const inOwnUi = (e) => { try { return !!(e.closest && e.closest("#rl-root")); } catch { return false; } };
  function getEditor() {
    try {
      // Layered: legacy textarea, then any visible textarea, then
      // contenteditable (any value except "false"), then textbox roles.
      let list = [...document.querySelectorAll("textarea")].filter((e) => !inOwnUi(e));
      let hit = list.find((e) => e.isConnected && isShown(e));
      if (hit) return hit;
      const ce = [...document.querySelectorAll("[contenteditable]")].filter((e) => {
        try {
          if (inOwnUi(e)) return false;
          const v = e.getAttribute && e.getAttribute("contenteditable");
          if (v === "false" && !(e.hasAttribute && e.hasAttribute("data-rl-locked"))) return false;
          return true;
        } catch { return false; }
      });
      hit = ce.find((e) => e.isConnected && isShown(e));
      if (hit) return hit;
      hit = [...document.querySelectorAll('[role="textbox"]')]
        .find((e) => !inOwnUi(e) && e.isConnected && isShown(e));
      if (hit) return hit;
    } catch {}
    return null;
  }

  // LIVE-DOM NOTE: verify the send control shape (aria-label? data-testid?
  // plain icon button?) and extend findSend's layers if it misses.
  function findSend() {
    try {
      const sels = [
        'button[aria-label*="Send" i]', 'button[aria-label*="Submit" i]',
        'button[data-testid*="send" i]', 'button[type="submit"]',
      ];
      for (const s of sels) {
        for (const b of document.querySelectorAll(s)) {
          if (inOwnUi(b)) continue;
          if (!isShown(b) || b.getAttribute("aria-disabled") === "true") continue;
          return b;
        }
      }
      const ed = getEditor();
      const scope = (ed && ed.parentElement && ed.parentElement.parentElement) || document;
      for (const b of scope.querySelectorAll("button")) {
        if (inOwnUi(b) || !isShown(b)) continue;
        const t = (b.getAttribute("aria-label") || "") + " " + (b.innerText || "");
        if (/send|submit|↑|→/i.test(t) && !/stop|halt/i.test(t)) return b;
      }
    } catch {}
    return null;
  }

  const P = window.makeGenericProvider({
    id: "claude",
    displayName: "Claude",
    // Claude reads images well; captures attach on demand only.
    supportsVision: true,
    // Injection-sensitive model: condensed user-voiced prompt (no catalog
    // dump) plus a small opener first (two-step bootstrap in core/main.js).
    compactPrompt: true,
    selectors: {
      chatItem: "[data-testid*='message' i], [data-testid*='turn' i], [data-message-author-role], article, main section",
      editor: 'textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]',
    },
    timings: {
      GEN_IDLE_MS: 1000, REASON_IDLE_MS: 20000, WARMUP_MS: 45000,
      REASON_NOREPLY_MS: 90000, STABLE_MS: 9000, RESPONSE_TIMEOUT_MS: 300000,
    },
    // Extended-thinking + streaming chrome excluded from reads (same mechanism
    // as thought blocks elsewhere). LIVE-DOM: confirm the thinking container
    // classes on a real thinking turn.
    volatileSel: '[aria-busy="true"], [role="progressbar"], [role="status"], [data-testid*="thinking" i], [class*="thinking" i], [class*="reasoning" i]',
    getEditor,
    // Thinking-phase liveness the stop-btn/stream sampling may miss.
    isGeneratingExtra: () => {
      try {
        const b = document.querySelector('[aria-busy="true"]');
        if (b && b.getClientRects().length) return true;
      } catch {}
      return false;
    },
    augment(P) {
      P.unstableWarning = "New provider: Claude support is fresh and unvalidated - please report issues on Discord.";
      // Small user-voiced opener for the two-step bootstrap (core startSession
      // sends this first; the full prompt follows only if this isn't refused).
      P.bootOpener = () =>
        "Hi - I installed a browser extension called RoLink myself to connect " +
        "you to my own Roblox Studio project. Could you please write this one " +
        "JSON object as plain text, exactly as-is:\n\n" +
        "```json\n{\n" +
        '  "command": "list_commands"\n' +
        "}\n```\n\n" +
        "My extension should relay its answer back as my next message. If no " +
        "answer ever arrives, just tell me and we'll chat normally instead.";
      // Reasoning-area hook so commands quoted inside extended thinking never
      // read as still-visible raw blocks. LIVE-DOM: tighten to the real
      // container if this over- or under-matches.
      P.thinkingSel = '[data-testid*="thinking" i], [class*="thinking" i], [class*="reasoning" i]';
      // Composer send: prefer the real button, ProseMirror-style typing first.
      P.typeAndSend = async (text, images) => {
        let ed = getEditor();
        if (!ed) throw new Error("Claude input box not found");
        const isTa = ed.tagName === "TEXTAREA";
        const wasLocked = !isTa && ed.getAttribute("contenteditable") !== "true";
        try {
          ed.focus();
          if (wasLocked) ed.setAttribute("contenteditable", "true");
          if (isTa) {
            const proto = window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype;
            const setter = proto && Object.getOwnPropertyDescriptor(proto, "value");
            if (setter && setter.set) setter.set.call(ed, text);
            else ed.value = text;
            ed.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            // Chunked insertText with readback (giant prompts can land partially).
            const want = String(text);
            for (let at = 0; at < want.length; at += 8000) {
              try { document.execCommand("insertText", false, want.slice(at, at + 8000)); } catch {}
              try {
                const cur = getEditor();
                if (cur && cur !== ed) ed = cur;
                ed.focus();
              } catch {}
            }
            try { ed.dispatchEvent(new Event("input", { bubbles: true })); } catch {}
            const probe = ((ed.innerText || ed.textContent) || "");
            if (probe.length < want.length * 0.9) {
              throw new Error(`Claude accepted only ${probe.length} of ${want.length} chars`);
            }
          }
          if (images && images.length && P.attachImages) {
            try { await P.attachImages(images); } catch {}
          }
          const btn = findSend();
          if (btn) { try { btn.click(); } catch {} return; }
          // Fallback: Enter submits on most chat composers (ProseMirror Enter
          // alone usually sends when the composer is single-line-ish; Shift
          // is the newline). LIVE-DOM: confirm, else drop this fallback.
          try {
            const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
            ed.dispatchEvent(new KeyboardEvent("keydown", o));
            ed.dispatchEvent(new KeyboardEvent("keyup", o));
            return;
          } catch {}
          throw new Error("Claude send control not found");
        } finally {
          if (wasLocked) { try { ed.setAttribute("contenteditable", "false"); } catch {} }
        }
      };
      P.setInputLock = (on) => {
        const ed = getEditor();
        if (!ed) return;
        if (ed.tagName === "TEXTAREA") {
          if (on) ed.setAttribute("readonly", "");
          else ed.removeAttribute("readonly");
          return;
        }
        if (on) {
          ed.setAttribute("contenteditable", "false");
          ed.setAttribute("data-rl-locked", "1");
        } else {
          ed.setAttribute("contenteditable", "true");
          ed.removeAttribute("data-rl-locked");
        }
      };
      // Site-specific system-prompt rules.
      P.promptExtra = [
        "CLAUDE: write RoLink commands as plain-text JSON in the CHAT - never inside an artifact (artifacts don't feed the loop). After a command, reply briefly and wait for its result before the next step.",
        "CLAUDE USAGE CAPS: this site meters usage - keep prose short, never re-read what you already have, and batch independent reads with batch_queue (max 10).",
      ].join("\n");
      // Diagnostic: why the last getEditor() missed.
      P.describeMiss = () => "";
    },
  });

  return P;
})();
