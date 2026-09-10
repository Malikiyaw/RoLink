// SPDX-License-Identifier: GPL-3.0-or-later
// rolink-extension/options.js — settings + multi-MCP server form.

const b = document.getElementById("bridge");
const m = document.getElementById("mcp");
const s = document.getElementById("status");
const ver = document.getElementById("ver");
chrome.storage.local.get(["bridgeUrl", "mcpUrl"], v => {
  if (v.bridgeUrl) b.value = v.bridgeUrl;
  if (v.mcpUrl) m.value = v.mcpUrl;
});
chrome.runtime.sendMessage({ type: "version" }, r => {
  if (r && r.version) ver.textContent = "v" + r.version;
});

function save() {
  chrome.storage.local.set({ bridgeUrl: b.value.trim(), mcpUrl: m.value.trim() }, () => {
    s.textContent = "Saved";
    s.className = "status ok";
    setTimeout(() => { s.textContent = ""; s.className = "status"; }, 1800);
  });
}
document.getElementById("save").onclick = save;
b.onkeydown = m.onkeydown = e => { if (e.key === "Enter") save(); };
document.getElementById("reset").onclick = () => {
  b.value = "ws://127.0.0.1:17613";
  m.value = "http://127.0.0.1:3001";
  save();
};

// ── multi-MCP server list (Phase 5a) ────────────────────────────────
const listEl = document.getElementById("mcpServerList");
const mcpStatusEl = document.getElementById("mcpStatus");
let mcpServers = [];

function renderMcpList() {
  if (!Array.isArray(mcpServers) || !mcpServers.length) {
    listEl.innerHTML = '<p class="desc">No additional MCP servers configured.</p>';
    return;
  }
  listEl.innerHTML = mcpServers.map(s => {
    const id = escapeHtml(s.id || s.server_id || "?");
    const cmd = escapeHtml(s.command || "");
    const args = escapeHtml((s.args || []).join(" "));
    const alive = s.alive === false ? "○ offline" : "● ready";
    return `
      <div class="row" style="margin:6px 0;padding:8px;background:#0d1117;border:1px solid var(--border);border-radius:6px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600">${id} <span class="status" style="font-weight:400">${alive}</span></div>
          <div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cmd} ${args}</div>
        </div>
        <button class="danger" data-remove="${id}">Remove</button>
      </div>`;
  }).join("");
  listEl.querySelectorAll("[data-remove]").forEach(btn => {
    btn.onclick = () => removeServer(btn.getAttribute("data-remove"));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);
}

function refreshMcpList() {
  chrome.runtime.sendMessage({ type: "list_mcp_servers" }, r => {
    mcpServers = (r && r.mcp_servers) || [];
    renderMcpList();
  });
}

function addServer() {
  const id = document.getElementById("newServerId").value.trim();
  const cmd = document.getElementById("newServerCmd").value.trim();
  const argsRaw = document.getElementById("newServerArgs").value.trim();
  const envRaw = document.getElementById("newServerEnv").value.trim();
  if (!id || !cmd) { mcpStatus("id and command required", true); return; }
  const args = argsRaw ? argsRaw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [] : [];
  const env = {};
  if (envRaw) {
    for (const kv of envRaw.split(",")) {
      const i = kv.indexOf("=");
      if (i > 0) env[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
  }
  chrome.runtime.sendMessage({ type: "add_server", server_id: id, command: cmd, args, env }, r => {
    if (r && r.ok) {
      mcpStatus("Added " + id);
      document.getElementById("newServerId").value = "";
      document.getElementById("newServerCmd").value = "";
      document.getElementById("newServerArgs").value = "";
      document.getElementById("newServerEnv").value = "";
      setTimeout(refreshMcpList, 800);
    } else {
      mcpStatus("Add failed: " + (r && r.error || "unknown"), true);
    }
  });
}

function removeServer(id) {
  if (!confirm("Remove MCP server '" + id + "'?")) return;
  chrome.runtime.sendMessage({ type: "remove_server", server_id: id }, r => {
    if (r && r.ok) { mcpStatus("Removed " + id); setTimeout(refreshMcpList, 800); }
    else mcpStatus("Remove failed: " + (r && r.error || "unknown"), true);
  });
}

function mcpStatus(msg, err) {
  mcpStatusEl.textContent = msg;
  mcpStatusEl.className = "status " + (err ? "err" : "ok");
  setTimeout(() => { mcpStatusEl.textContent = ""; mcpStatusEl.className = "status"; }, 2200);
}

document.getElementById("addServer").onclick = addServer;
refreshMcpList();

// ── P4 HUD category toggles ─────────────────────────────────────────
// Must stay in sync with ui/toolHud/toolRegistry.js CATEGORY_ORDER/COLORS.
// Stored as an array of hidden category names under `rl-hidden-cats`.
const HUD_CATS = [
  ["read", "#5B8DEF", "Reads & queries"],
  ["edit", "#FFB800", "Edits & creates"],
  ["inspect", "#00E5FF", "Snapshots & explore"],
  ["generate", "#FF6B35", "Generators"],
  ["asset", "#F472B6", "Marketplace assets"],
  ["visual", "#A855F7", "UI, light & sound"],
  ["test", "#00FF88", "Tests & sims"],
  ["tool", "#94A3B8", "Ops & misc"],
];
const HIDDEN_CATS_KEY = "rl-hidden-cats";
const catBox = document.getElementById("catToggles");
function renderCatToggles(hidden) {
  const set = new Set(Array.isArray(hidden) ? hidden : []);
  catBox.innerHTML = HUD_CATS.map(([name, color, desc]) => `
    <label class="cat-row">
      <input type="checkbox" data-cat="${name}" ${set.has(name) ? "" : "checked"}>
      <span class="cat-dot" style="background:${color}"></span>
      <span class="cn">${name}</span>
      <span class="cd">${desc}</span>
    </label>`).join("");
  catBox.querySelectorAll("input[data-cat]").forEach(box => {
    box.onchange = () => {
      const nowHidden = HUD_CATS.map(([n]) => n).filter(n => {
        const el = catBox.querySelector(`input[data-cat="${n}"]`);
        return el && !el.checked;
      });
      chrome.storage.local.set({ [HIDDEN_CATS_KEY]: nowHidden }, () => {
        s.textContent = "Categories saved";
        s.className = "status ok";
        setTimeout(() => { s.textContent = ""; s.className = "status"; }, 1500);
      });
    };
  });
}
chrome.storage.local.get([HIDDEN_CATS_KEY], v => {
  renderCatToggles(v && v[HIDDEN_CATS_KEY]);
});
