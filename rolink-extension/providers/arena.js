// SPDX-License-Identifier: GPL-3.0-or-later
// providers/arena.js - thin wrapper for arena.ai.
// Arena is a multi-model playground; we only support Direct mode.
(function(){
  if(typeof window.makeGenericProvider !== "function") return;
  window.ZSProvider = window.makeGenericProvider({
    id: "arena",
    displayName: "Arena",
    augment: (P) => {
      P.ensureComposerReady = async () => {
        // Block Start unless Direct mode is selected.
        const html = document.body.innerHTML || "";
        const modeIsBattle = /data-testid="(battle|side-by-side|sideBySide|sidebyside|ab-test|compare)"/i.test(html) ||
                              /side-?by-?side|sideby|abtest|a\/b|compare/i.test(document.querySelector('[aria-selected="true"]')?.textContent || "");
        if(modeIsBattle){
          return {ready: false, reason: "Arena: switch to Direct mode to use RoLink."};
        }
        return {ready: true};
      };
    }
  });
})();
