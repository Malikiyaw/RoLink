// SPDX-License-Identifier: GPL-3.0-or-later
// core/parser.js - pure string parser for ZeroScript tool blocks.
// Exposes window.ZSParse (or module.exports) for use by core/main.js and providers.
//
// Recognized shapes (all equivalent):
//   ###MCP_TOOL###
//   {"tool":"run_code","args":{"code":"print('hi')"}}
//
//   ###LUA###
//   print('hi')
//   ###END_LUA###       (legacy ZeroScript/Roblox DSL)
//
//   ```json
//   {"command":"run_code","params":{"code":"..."}}
//   ```
//   (raw JSON code block)
//
//   {"tool":"run_code", ...}   (function-calling flavour, no markers)
//
// Returns {tool, args, type:'tool'|'lua'|'json'|'unknown', raw} for the first
// valid tool block in `text`, or null.

(function (root) {
  "use strict";

  const START_M = "###MCP_TOOL###";
  const LUA_START_RE = /###LUA###|```lua/i;
  const LUA_END_RE = /###END_LUA###|```/;
  const CMD_KEY_RE = /(command|tool)/;
  const DSML_RE = /<\|DSML\|>/g;

  // Brace-aware JSON finder (respects strings + escapes).
  function matchBrace(s, start) {
    let depth = 0, inStr = false, esc = false, q = "";
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === q) inStr = false;
      } else {
        if (c === '"' || c === "'") { inStr = true; q = c; }
        else if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) return i; }
      }
    }
    return -1;
  }

  // Tolerant JSON parse: escape tabs, salvage cut-off by closing braces.
  function parseLoose(t) { return JSON.parse(t.replace(/\t/g, "\\t")); }
  function salvageCutOff(s) {
    let o = (s.match(/\{/g) || []).length, c = (s.match(/\}/g) || []).length;
    if (o > c) s += "}".repeat(o - c);
    try { return JSON.parse(s); } catch { return null; }
  }

  // Try to recover a single tool call from a cut-off / malformed JSON envelope.
  // Returns the SAME shape as `normalize()` (so the main loop can dispatch it
  // directly) or null if no recovery is possible. Refuses amputated content
  // (mid-string / deep deficit) so we never run a half-written command.
  function salvageCutOffCall(s) {
    if(!s) return null;
    // 1) Find the LAST `###MCP_TOOL###` marker; the body is the JSON after it.
    const idx = s.lastIndexOf(START_M);
    if(idx === -1) return null;
    const body = s.slice(idx + START_M.length);
    const start = body.indexOf("{");
    if(start === -1) return null;
    const chunk = body.slice(start);
    // Refuse amputated strings: a JSON with an odd number of unescaped quotes
    // means we cut in the middle of a string. Closing it would corrupt the args.
    const m = chunk.match(/(?<!\\)"/g) || [];
    if(m.length % 2 !== 0) return null;
    const recovered = salvageCutOff(chunk);
    if(!recovered || typeof recovered !== "object") return null;
    return normalize({ kind: "mcp", json: recovered, raw: chunk, lua: null });
  }

  // Find the brace-balanced JSON chunk that starts at `b` in `s`. Returns "" if
  // no matching close-brace (caller may then try salvageCutOff).
  function readJsonChunk(s, b) {
    const end = matchBrace(s, b);
    return end !== -1 ? s.slice(b, end + 1) : s.slice(b);
  }

  // Extract the FIRST tool block of any recognized shape from `text`.
  // Returns { kind:'mcp'|'lua'|'json'|'fn', json, lua, raw } or null.
  function extract(text) {
    if (!text) return null;
    text = text.replace(DSML_RE, "");

    // 1) ###MCP_TOOL### (our new format)
    let m = text.indexOf(START_M);
    if (m !== -1) {
      const b = text.indexOf("{", m);
      if (b !== -1) {
        const chunk = readJsonChunk(text, b);
        let json = null;
        try { json = parseLoose(chunk); }
        catch { json = salvageCutOff(chunk); }
        if (json && (json.tool || json.command)) {
          return { kind: "mcp", json, raw: chunk, lua: null };
        }
      }
    }

    // 2) ###LUA### ... ###END_LUA### (legacy)
    const lstart = text.search(LUA_START_RE);
    if (lstart !== -1) {
      // Find body start: after the opening marker / fence
      const afterMarker = (() => {
        const m = text.slice(lstart).match(LUA_START_RE);
        if (!m) return lstart;
        return lstart + m[0].length;
      })();
      const lend = text.indexOf("###END_LUA###", afterMarker);
      let body;
      if (lend !== -1) {
        body = text.slice(afterMarker, lend).replace(/^[\r\n]+|[\r\n]+$/g, "");
        // strip closing ``` from ```lua ... ```
        body = body.replace(/```\s*$/, "").replace(/^\s*```/, "").trim();
      } else {
        // Open ```lua but no close: take until end of text or next ``` (code fence end)
        const fenceEnd = text.indexOf("```", afterMarker);
        body = text.slice(afterMarker, fenceEnd === -1 ? text.length : fenceEnd);
        body = body.replace(/^[\r\n]+/, "").replace(/```\s*$/, "").trim();
      }
      if (body) {
        // Wrap as an execute_luau tool call (the real name the bridge advertises).
        return { kind: "lua", json: { tool: "execute_luau", args: { code: body } }, raw: body, lua: body };
      }
    }

    // 3) Raw JSON code block with command/tool key
    const jsonBlock = text.match(/```(?:json)?\s*\n?\s*(\{[\s\S]+?\})\s*\n?\s*```/);
    if (jsonBlock) {
      try {
        const j = parseLoose(jsonBlock[1]);
        if (j && (j.command || j.tool)) {
          return { kind: "json", json: j, raw: jsonBlock[1], lua: null };
        }
      } catch { /* fall through */ }
    }

    // 4) Function-calling flavour: bare JSON object with tool/command
    const fnCall = text.match(/(\{[^{}]*?"(?:tool|command|function)":\s*"[A-Za-z0-9_\-\.\/]+"[^{}]*?\})/);
    if (fnCall) {
      let j = null;
      try { j = parseLoose(fnCall[1]); } catch { j = salvageCutOff(fnCall[1]); }
      if (j && (j.tool || j.command || j.function)) {
        return { kind: "fn", json: j, raw: fnCall[1], lua: null };
      }
    }

    return null;
  }

  // Extract EVERY tool block from `text` (in document order).
  function extractAll(text) {
    if (!text) return [];
    text = text.replace(DSML_RE, "");
    const out = [];
    let i = 0;
    let safety = 0;
    while (i < text.length && safety++ < 200) {
      // find the NEXT block of any kind, starting at position i
      const sub = text.slice(i);
      const idxMcp = sub.indexOf(START_M);
      const idxLua = sub.search(LUA_START_RE);
      // Also find a raw JSON code block
      const idxJson = sub.search(/```(?:json)?\s*\n?\s*\{/);
      // And a function-calling flavour (bare JSON with tool/command)
      const idxFn = (function(){
        const m = sub.match(/\{[\s\S]*?"(?:tool|command|function)"\s*:\s*"/);
        return m ? m.index : -1;
      })();

      const candidates = [];
      if (idxMcp !== -1) candidates.push({pos: i + idxMcp, type: "mcp"});
      if (idxLua !== -1) candidates.push({pos: i + idxLua, type: "lua"});
      if (idxJson !== -1) candidates.push({pos: i + idxJson, type: "json"});
      if (idxFn !== -1) candidates.push({pos: i + idxFn, type: "fn"});
      if (!candidates.length) break;
      candidates.sort((a, b) => a.pos - b.pos);
      const head = candidates[0];
      // Extract from this position
      const slice = text.slice(head.pos);
      const blk = extract(slice);
      if (!blk) {
        // Couldn't parse; advance past the marker so we don't loop forever
        i = head.pos + (head.type === "mcp" ? START_M.length : (head.type === "lua" ? 10 : 4));
        continue;
      }
      out.push(blk);
      // Advance by the consumed raw length; if raw is missing/short, bump by marker length + 1
      const advance = blk.raw && blk.raw.length > 0
        ? blk.raw.length
        : (head.type === "mcp" ? START_M.length : (head.type === "lua" ? 10 : 4)) + 1;
      i = head.pos + advance;
    }
    return out;
  }

  // True if text contains ANY tool signature (used to decide if a reply needs
  // a nudge vs is the AI answering the user).
  function hasToolSignature(text) {
    if (!text) return false;
    if (text.indexOf(START_M) !== -1) return true;
    if (LUA_START_RE.test(text)) return true;
    if (/```(?:json)?\s*\n?\s*\{[\s\S]+?"(?:command|tool)"\s*:/.test(text)) return true;
    if (/\{[\s\S]*?"(?:tool|command|function)"\s*:\s*"(execute_luau|create_instance|set_property|get_snapshot|get_studio_state|list_roblox_studios|get_instance_tree|search_assets|import_asset|generate_asset|start_stop_play|run_command|publish_place|multi_edit|script_read|script_grep|inspect_instance|search_game_tree)\b/.test(text)) return true;
    return false;
  }

  // True if `text` has an UNCLOSED ###LUA### or ###MCP_TOOL### block (so we
  // should NOT finalize the reply yet — the AI is still writing the call).
  function hasOpenToolBlock(text) {
    if (!text) return false;
    let opens = 0, closes = 0;
    const luaOpens = (text.match(/###LUA###|```lua/gi) || []).length;
    const luaCloses = (text.match(/###END_LUA###|```/g) || []).length;
    // Heuristic: an unclosed MCP_TOOL marker with no matching closing brace
    const mcpOpen = text.indexOf(START_M);
    if (mcpOpen !== -1) {
      const after = text.slice(mcpOpen + START_M.length);
      const o = (after.match(/\{/g) || []).length, c = (after.match(/\}/g) || []).length;
      if (o > c) return true;
    }
    if (luaOpens > 0 && luaCloses <= luaOpens) return true;
    return false;
  }

  // Extract the bare tool name from a chunk (used for "known tool?" check).
  function toolNameFromText(text) {
    const m = text.match(/"(?:tool|command|function|name)"\s*:\s*"([A-Za-z0-9_\-\.\/]+)"/);
    return m ? m[1] : null;
  }

  // Normalize a parsed block into a unified dispatch shape the bridge understands.
  // Bridge expects: { name, arguments } via the call_tool WS message.
  function normalize(blk) {
    if (!blk || !blk.json) return null;
    const j = blk.json;
    const name = j.tool || j.command || j.function || j.name;
    if (!name) return null;
    // arguments can live under: args, arguments, params, or top-level (for fn call)
    let args = j.args || j.arguments || j.params || null;
    if (args == null) {
      // function-calling flavour: everything except the name key is the arg
      const copy = Object.assign({}, j);
      delete copy.tool; delete copy.command; delete copy.function; delete copy.name;
      args = copy;
    }
    return { name, arguments: args, kind: blk.kind, raw: blk.raw };
  }

  const api = { START_M, LUA_START_RE, LUA_END_RE, CMD_KEY_RE, DSML_RE,
                matchBrace, parseLoose, salvageCutOff, salvageCutOffCall, extract, extractAll,
                hasToolSignature, hasOpenToolBlock, toolNameFromText, normalize };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.ZSParse = api;
})(typeof window !== "undefined" ? window : globalThis);
