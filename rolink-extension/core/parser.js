// SPDX-License-Identifier: GPL-3.0-or-later
// RoLink parser: tolerant extraction, strict ambiguity rejection.
// Legacy ZeroScript-compatible shapes remain supported. RoLink additionally
// accepts a raw-field escape hatch that works for EVERY string field declared
// in any tool's Zod inputSchema (no hardcoded field list):
//
//   ###MCP_TOOL###
//   {"tool":"set_script_content","args":{"path":"..."}}
//   ###RAW:content###
//   local value = "quotes and newlines are literal here"
//   ###END_RAW###
//
// Or, when the JSON arguments themselves are missing/broken, the tool-scoped
// form ###TOOL:<name>### ... ###END_TOOL### bundles the raw fields together.
//
// The set of recognised raw field names comes from
// rolink-extension/core/code-fields.js (a generated file derived from
// mcp-server/src/tools/registry.ts). When the page has not loaded that
// content script (e.g. unit tests, a stripped-down page), the parser falls
// back to a conservative built-in list.

(function (root) {
  "use strict";

  const START_M = "###MCP_TOOL###";
  const END_M = "###END_MCP_TOOL###";
  const RAW_RE = /###RAW:([A-Za-z0-9_.\[\]{}-]+)###([\s\S]*?)###END_RAW###/g;
  const TOOL_RAW_START_RE = /###TOOL:([A-Za-z0-9_.-]+)###/;
  const TOOL_RAW_END = "###END_TOOL###";
  // Whitespace-tolerant LUA marker (ZeroScript parity): accept "### lua ###",
  // "###lua---", and the datamodel suffix "###LUA:Edit###" / "###LUA-Client###"
  // / "###LUA_Server###". The optional suffix selects the Roblox datamodel
  // execute_luau runs against; bare ###LUA### defaults to "Edit".
  const LUA_START_RE = /###\s*lua(?:\s*[:\-_ ]\s*(edit|client|server))?\s*(?:###|---)/i;
  const LUA_END_RE = /###\s*end[_\- ]?lua\s*###/i;
  const LUA_DEFAULT_DM = "Edit";
  const DSML_RE = /<[\s\/]*[|｜][\s|｜]*DSML[\s|｜]*[|｜]/i;
  // Extended chrome stripping (Kimi/GLM/Qwen render bleed): ```lua fences,
  // "Copy"/"Copy code" button captions, BOM/ZWSP/NBSP, smart quotes. The
  // negative lookahead protects legit identifiers: Copy(x), copycat,
  // jsonify are never stripped (requires trailing whitespace so a script
  // genuinely starting with Copy(x) survives).
  const CODE_CHROME_RE = /^(?:```(?:lua|luau|json)?|copy\s+code|json|copy)(?![A-Za-z0-9_(])[\s\u200b\u200c\u200d\ufeff]*/i;
  const CODE_CHROME_TRAIL_RE = /[\s\u200b\u200c\u200d\ufeff]*```[\s\u200b\u200c\u200d\ufeff]*$/;
  const ZWSP_RE = /[\u200b\u200c\u200d\ufeff]/g;

  // Fallback list (used only when code-fields.js didn't load). Kept short on
  // purpose — it is NOT the source of truth. The real list is in
  // rolink-extension/core/code-fields.js.
  const FALLBACK_STRING_FIELDS = new Set([
    "code","content","source","script","text","string","handler","handlerCode",
    "exports","prompt","query","description","label","message","expression",
    "command","newText","oldText","new_text","old_text","newString","oldString",
    "new_string","old_string","event","name","path","tool","type","format",
    "input","output","model","template","body"
  ]);

  function getStringFields() {
    const fromGen = (root && root.ROLINK_CODE_FIELDS && root.ROLINK_CODE_FIELDS.stringFields) || null;
    if (Array.isArray(fromGen) && fromGen.length) return new Set(fromGen);
    return FALLBACK_STRING_FIELDS;
  }

  function stripDSML(text) {
    return String(text || "").replace(DSML_RE, "");
  }

  // Strip a code-block UI label (the "Copy" button caption, or a leftover
  // fence language token like "json") that some sites bleed into the block's
  // text right after the opening marker. Seen live on Kimi: its code-block
  // chrome renders as `###lua### Copy <code>`, so the bare-marker slice below
  // would capture `Copy task.wait(...)` as the Lua code - not valid Lua, so
  // StudioMCP rejects it with "Failed to parse command code". Requires
  // trailing whitespace so it never eats a legitimate identifier like
  // `Copy(x)` that a script might genuinely start with.
  function stripCodeChrome(code) {
    let s = String(code || "").replace(ZWSP_RE, "").replace(/^\uFEFF/, "");
    // Smart quotes / NBSP from rich-text renders break Studio loadstring.
    s = s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/\u00a0/g, " ");
    s = s.replace(CODE_CHROME_RE, "");
    s = s.replace(CODE_CHROME_TRAIL_RE, "");
    return s;
  }

  // Find the first LUA start marker at or after `from`. Returns { pos, len, dm }
  // where len is the marker's own length to skip past it and dm the requested
  // datamodel ("Edit" when unspecified).
  function findLuaStart(text, from) {
    const sliceFrom = from || 0;
    const m = LUA_START_RE.exec(text.slice(sliceFrom));
    return m ? { pos: sliceFrom + m.index, len: m[0].length, dm: dmName(m[1]) } : { pos: -1, len: 0, dm: LUA_DEFAULT_DM };
  }
  function findLuaEnd(text, from) {
    const sliceFrom = from || 0;
    const m = LUA_END_RE.exec(text.slice(sliceFrom));
    return m ? sliceFrom + m.index : -1;
  }
  function dmName(m) {
    if (!m) return LUA_DEFAULT_DM;
    return m[0].toUpperCase() + m.slice(1).toLowerCase();
  }

  function scanBalancedObject(text, start) {
    if (text[start] !== "{") return { end: -1, balanced: false, inString: false };
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escape) { escape = false; continue; }
        if (c === "\\") { escape = true; continue; }
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return { end: i, balanced: true, inString: false };
      }
    }
    return { end: -1, balanced: false, inString };
  }

  function evenUnescapedQuoteCount(text) {
    let count = 0, escape = false;
    for (const c of text) {
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') count++;
    }
    return count % 2 === 0;
  }

  function tryJSON(text) {
    try { return { value: JSON.parse(text.replace(/\t/g, "\\t")), repaired: false, repairReason: null }; }
    catch { return null; }
  }

  // Field-name independent repair. A quote inside a string is treated as data
  // unless the next significant character is valid JSON structure. This means
  // new string fields inherit repair automatically instead of relying on a
  // hardcoded field-name list.
  function repairJSONStringValues(input) {
    let out = "";
    let inString = false;
    let escape = false;
    let repaired = false;
    let repairedFields = 0;
    let openStringSawQuote = false;

    function nextMeaningful(i) {
      while (i < input.length && /\s/.test(input[i])) i++;
      return input[i] || "";
    }

    function keyBefore(i) {
      const before = input.slice(Math.max(0, i - 120), i);
      const m = before.match(/"([^"\\]+)"\s*:\s*$/);
      return m ? m[1] : null;
    }

    for (let i = 0; i < input.length; i++) {
      const c = input[i];
      if (!inString) {
        out += c;
        if (c === '"') {
          inString = true;
          openStringSawQuote = false;
        }
        continue;
      }

      if (escape) { out += c; escape = false; continue; }
      if (c === "\\") { out += c; escape = true; continue; }
      if (c === "\n") { out += "\\n"; repaired = true; continue; }
      if (c === "\r") { out += "\\r"; repaired = true; continue; }
      if (c === "\t") { out += "\\t"; repaired = true; continue; }

      if (c === '"') {
        const next = nextMeaningful(i + 1);
        const structural = next === "," || next === "}" || next === "]" || next === ":";
        if (!structural) {
          out += "\\\"";
          repaired = true;
          repairedFields++;
          openStringSawQuote = true;
          continue;
        }
        out += c;
        inString = false;
        continue;
      }
      out += c;
    }

    if (inString) {
      if (openStringSawQuote) {
        // The truncated string already contained a raw (escaped or not)
        // double-quote. The truncation is ambiguous: was the AI mid-string
        // when it cut off, or did it just forget to close? Tier-1 tools
        // must reject rather than guess.
        return null;
      }
      // Unterminated string with no rogue quotes — safe to close.
      out += '"';
      repaired = true;
      repairedFields++;
    }

    if (!repaired) return null;
    return { text: out, repaired: true, repairReason: `generic-string-repair:${repairedFields || 1}` };
  }

  function salvageObject(text) {
    if (!text || !evenUnescapedQuoteCount(text)) return null;
    const candidate = text.trim();
    const open = (candidate.match(/{/g) || []).length;
    const close = (candidate.match(/}/g) || []).length;
    if (open <= close) return null;
    const repaired = tryJSON(candidate + "}".repeat(open - close));
    return repaired ? { ...repaired, repaired: true, repairReason: "balanced-object-salvage" } : null;
  }

  function extractRawBlocks(text, allowed) {
    const rawFields = {};
    const re = new RegExp(RAW_RE.source, "g");
    let match;
    while ((match = re.exec(text))) {
      const name = match[1];
      const baseName = name.replace(/\[\]$|\{\}$/g, "");
      if (!allowed.has(baseName) && !allowed.has(name)) rawFields[name] = { value: match[2].replace(/^\r?\n/, "").replace(/\r?\n$/, ""), unknown: true };
      else rawFields[name] = { value: match[2].replace(/^\r?\n/, "").replace(/\r?\n$/, ""), unknown: false };
    }
    return rawFields;
  }

  function applyRawFields(normalized, rawFields) {
    if (!normalized || !Object.keys(rawFields).length) return normalized;
    const args = { ...(normalized.args || {}) };
    const rawPublic = {};
    let unknownCount = 0;
    for (const [field, entry] of Object.entries(rawFields)) {
      const value = entry && typeof entry === "object" ? entry.value : entry;
      const unknown = entry && typeof entry === "object" ? entry.unknown : false;
      if (unknown) unknownCount++;
      if (field.endsWith("[]")) {
        const key = field.slice(0, -2);
        args[key] = Array.isArray(args[key]) ? [...args[key], value] : [value];
        if (!Array.isArray(rawPublic[key])) rawPublic[key] = [];
        rawPublic[key].push(value);
      } else {
        args[field] = value;
        rawPublic[field] = value;
      }
    }
    if (unknownCount) rawPublic.__unknown = unknownCount;
    return { ...normalized, args, rawFields: rawPublic };
  }

  function normalize(raw, meta) {
    if (!raw || typeof raw !== "object") return null;
    const json = raw.json && typeof raw.json === "object" ? raw.json : raw;
    const tool = json.tool || json.command || json.function || json.name;
    if (!tool || typeof tool !== "string") return null;
    let args = json.args ?? json.arguments ?? json.params ?? json.parameters ?? {};
    if (args == null || typeof args !== "object" || Array.isArray(args)) args = {};
    // Aliases (.name / .arguments) keep legacy ZeroScript-style call sites
    // working. The canonical fields are .tool / .args; the aliases are
    // shallow copies, so callers that mutate .arguments will not see the
    // mutation in .args (and vice versa). In practice callers only read.
    return {
      tool,
      name: tool,
      args,
      arguments: args,
      type: meta?.type || raw.type || "tool",
      raw: meta?.raw ?? raw.raw ?? JSON.stringify(json),
      repaired: !!meta?.repaired,
      repairReason: meta?.repairReason || null,
      rawFields: meta?.rawFields || {}
    };
  }

  function parseMcp(text, allowed) {
    const marker = text.indexOf(START_M);
    if (marker < 0) return null;
    const brace = text.indexOf("{", marker + START_M.length);
    if (brace < 0) return null;
    const scanned = scanBalancedObject(text, brace);

    if (scanned.balanced) {
      const chunk = text.slice(brace, scanned.end + 1);
      const direct = tryJSON(chunk);
      if (direct?.value && (direct.value.tool || direct.value.command || direct.value.function)) {
        return normalize(direct.value, { type: "mcp", raw: chunk });
      }
      const repaired = repairJSONStringValues(chunk);
      if (repaired) {
        const parsed = tryJSON(repaired.text);
        if (parsed?.value && (parsed.value.tool || parsed.value.command || parsed.value.function)) {
          return normalize(parsed.value, { type: "mcp", raw: chunk, repaired: true, repairReason: repaired.repairReason });
        }
      }
      return null;
    }

    // Missing closing braces are recoverable only when string boundaries are
    // intact. Mid-string truncation is rejected and never executed.
    const chunk = text.slice(brace);
    const repaired = repairJSONStringValues(chunk);
    if (repaired) {
      // After string repair, try direct parse first (the repair may already
      // have produced a balanced, well-formed object).
      const direct = tryJSON(repaired.text);
      if (direct?.value && (direct.value.tool || direct.value.command || direct.value.function)) {
        return normalize(direct.value, { type: "mcp", raw: chunk, repaired: true, repairReason: repaired.repairReason });
      }
      const parsed = salvageObject(repaired.text);
      if (parsed?.value && (parsed.value.tool || parsed.value.command || parsed.value.function)) {
        return normalize(parsed.value, { type: "mcp", raw: chunk, repaired: true, repairReason: `${repaired.repairReason}+balanced-object-salvage` });
      }
      return null;
    }
    // No repair was needed. If the brace structure is incomplete but the
    // string boundaries are intact (last `"` closed something), try a
    // pure brace-balancing salvage.
    if (!scanned.inString) {
      const salvaged = salvageObject(chunk);
      if (salvaged?.value && (salvaged.value.tool || salvaged.value.command || salvaged.value.function)) {
        return normalize(salvaged.value, { type: "mcp", raw: chunk, repaired: true, repairReason: salvaged.repairReason });
      }
    }
    // Either the string is unterminated (with or without a rogue quote) or
    // salvage failed. Either way: reject rather than guess. Tier-1 tools
    // must never run on ambiguous input.
    nudgeCounters.midStringTruncation++;
    return null;
  }

  function parseLua(text) {
    const ls = findLuaStart(text);
    if (ls.pos === -1) return null;
    const le = findLuaEnd(text, ls.pos + ls.len);
    if (le === -1) return null;
    const body = stripCodeChrome(text.slice(ls.pos + ls.len, le).replace(/^\s+|\s+$/g, ""));
    if (!body) return null;
    return normalize({ tool: "execute_luau", args: { code: body, datamodel_type: ls.dm } }, { type: "lua", raw: body });
  }

  // Strip a leading ###LUA### (with optional datamodel suffix) and trailing
  // ###END_LUA### from execute_luau's code. Used when a model wraps execute_luau
  // in a JSON envelope and KEEPS the markers inside the code string
  // (seen live on GLM: `{"command":"execute_luau","params":{"code":"###LUA###\n<lua>\n###END_LUA###"}}`).
  // Idempotent. When the code came from a ###RAW:code### block the value is
  // passed through VERBATIM (no trim, no chrome-strip) — the model already
  // opted out of JSON escaping for that field, so we don't second-guess.
  function cleanLuaCall(call) {
    if (!call || call.tool !== "execute_luau") return call;
    let code = call.args && call.args.code;
    if (typeof code !== "string") return call;
    const fromRaw = call.rawFields && Object.prototype.hasOwnProperty.call(call.rawFields, "code");
    // Multi-pass: nested/duplicate markers (model wraps twice) are stripped
    // until fixpoint, max 3 passes. Idempotent — running twice is a no-op.
    for (let pass = 0; pass < 3; pass++) {
      const s = findLuaStart(code);
      if (s.pos === -1) break;
      const e = findLuaEnd(code, s.pos + s.len);
      code = code.slice(s.pos + s.len, e === -1 ? code.length : e).trim();
      if (!call.args.datamodel_type) call.args.datamodel_type = s.dm;
    }
    if (fromRaw) {
      // RAW block: model opted out of JSON escaping — pass through verbatim
      // except marker residue already sliced above.
      call.args.code = code;
    } else {
      // JSON-envelope path: strip render chrome (Copy/fences/ZWSP/quotes).
      call.args.code = stripCodeChrome(code.trim());
    }
    return call;
  }

  // String-aware matching-brace finder: index of the "}" that closes the "{"
  // at `start`, SKIPPING braces inside JSON string literals (escaped quotes
  // handled). A naive depth counter miscounts braces embedded in code passed
  // as a string value (multi_edit's edits, a Lua snippet), grabs the wrong
  // end, and makes JSON.parse fail - which silently drops the command.
  // Returns -1 if unbalanced.
  function matchBrace(text, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { if (--depth === 0) return i; }
    }
    return -1;
  }

  // Last-resort salvage of a CUT-OFF JSON command: the model hit its output
  // limit with the whole payload complete but the trailing closers missing
  // (seen live on Qwen: a big multi_edit missing exactly ONE final "}").
  // Strictly conservative - we only auto-close when it is provably just the
  // closing sequence that was lost, never when actual content was amputated:
  //  - the scan must NOT end inside a string literal
  //  - the last non-whitespace char must terminate a complete JSON value
  //    (`"`, `}`, `]`, digit, or the tail of true/false/null)
  //  - at most MAX_SALVAGE_CLOSERS closers may be appended
  // Callers must only invoke this once generation has ENDED.
  const MAX_SALVAGE_CLOSERS = 2;
  function salvageCutOff(text) {
    for (const key of ['"command"', '"tool"']) {
      const k = text.indexOf(key);
      if (k === -1) continue;
      const start = text.lastIndexOf("{", k);
      if (start === -1) continue;
      if (matchBrace(text, start) !== -1) continue;
      const stack = [];
      let inStr = false, esc = false;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === "{") stack.push("}");
        else if (c === "[") stack.push("]");
        else if (c === "}" || c === "]") {
          if (stack.pop() !== c) return null;
        }
      }
      if (inStr) return null;
      if (!stack.length || stack.length > MAX_SALVAGE_CLOSERS) return null;
      const body = text.slice(start).trimEnd();
      if (!/["}\]0-9]$|(?:true|false|null)$/.test(body)) return null;
      try {
        const closed = body + stack.reverse().join("");
        const v = JSON.parse(closed);
        const name = v.command != null ? v.command : (v.tool != null ? v.tool : v.name);
        let args = v.params != null ? v.params : (v.arguments != null ? v.arguments : v.args);
        if (typeof name !== "string" || !name) return null;
        if (!args || typeof args !== "object") args = {};
        return normalize({ tool: name, arguments: args }, { type: "salvaged", raw: body, repaired: true, repairReason: "salvaged-cut-off" });
      } catch (e) { return null; }
    }
    return null;
  }

  function parseRawTool(text, allowed) {
    const marker = text.match(TOOL_RAW_START_RE);
    if (!marker) return null;
    const tool = marker[1];
    const start = (marker.index || 0) + marker[0].length;
    const endMarker = text.indexOf(TOOL_RAW_END, start);
    const body = text.slice(start, endMarker >= 0 ? endMarker : text.length);
    const rawFields = extractRawBlocks(body, allowed);
    let args = {};
    const rawJson = body.replace(RAW_RE, "").trim();
    if (rawJson) {
      const brace = rawJson.indexOf("{");
      if (brace >= 0) {
        const chunk = rawJson.slice(brace);
        const scanned = scanBalancedObject(chunk, 0);
        const candidate = scanned.balanced ? chunk.slice(0, scanned.end + 1) : chunk;
        const direct = tryJSON(candidate);
        const repaired = direct || (() => { const r = repairJSONStringValues(candidate); return r ? tryJSON(r.text) : null; })();
        if (repaired?.value?.args && typeof repaired.value.args === "object") args = repaired.value.args;
        else if (repaired?.value && typeof repaired.value === "object") args = repaired.value;
      }
    }
    const normalized = { tool, args, type: "raw-tool", raw: body, repaired: false, repairReason: null, rawFields: {} };
    return applyRawFields(normalized, rawFields);
  }

  function parseJsonFence(text) {
    const m = text.match(/```(?:json)?\s*\n?\s*(\{[\s\S]+?\})\s*\n?\s*```/i);
    if (!m) return null;
    const direct = tryJSON(m[1]);
    if (direct?.value) return normalize(direct.value, { type: "json", raw: m[1] });
    const repaired = repairJSONStringValues(m[1]);
    if (!repaired) return null;
    const parsed = tryJSON(repaired.text);
    return parsed?.value ? normalize(parsed.value, { type: "json", raw: m[1], repaired: true, repairReason: repaired.repairReason }) : null;
  }

  function parseBare(text) {
    const m = text.match(/\{[\s\S]*?"(?:tool|command|function)"\s*:\s*"[A-Za-z0-9_./-]+"/);
    if (!m) return null;
    const start = m.index || 0;
    const scanned = scanBalancedObject(text, start);
    const candidate = scanned.balanced ? text.slice(start, scanned.end + 1) : text.slice(start);
    const direct = tryJSON(candidate);
    if (direct?.value && (direct.value.tool || direct.value.command || direct.value.function)) {
      return normalize(direct.value, { type: "fn", raw: candidate });
    }
    const repaired = repairJSONStringValues(candidate);
    if (!repaired) return null;
    const parsed = tryJSON(repaired.text);
    return parsed?.value ? normalize(parsed.value, { type: "fn", raw: candidate, repaired: true, repairReason: repaired.repairReason }) : null;
  }

  function extract(text) {
    const source = stripDSML(text);
    if (!source) return null;
    const allowed = getStringFields();
    const rawTool = parseRawTool(source, allowed);
    if (rawTool) return cleanLuaCall(rawTool);
    const mcp = parseMcp(source, allowed);
    if (mcp) return cleanLuaCall(applyRawFields(mcp, extractRawBlocks(source, allowed)));
    const lua = parseLua(source);
    if (lua) return cleanLuaCall(lua);
    const json = parseJsonFence(source);
    if (json) return cleanLuaCall(json);
    return cleanLuaCall(parseBare(source));
  }

  function extractAll(text) {
    const source = stripDSML(text);
    const out = [];
    let remaining = source;
    let guard = 0;
    while (remaining && guard++ < 200) {
      const candidates = [
        [remaining.indexOf(START_M), parseMcp],
        [remaining.search(LUA_START_RE), parseLua],
        [remaining.indexOf("```json"), parseJsonFence],
        [remaining.search(TOOL_RAW_START_RE), parseRawTool],
        [remaining.search(/\{[\s\S]*?"(?:tool|command|function)"\s*:\s*"/), parseBare],
      ].filter(([idx]) => idx >= 0).sort((a, b) => a[0] - b[0]);
      if (!candidates.length) break;
      const [idx, parser] = candidates[0];
      const allowed = getStringFields();
      const slice = remaining.slice(idx);
      let parsed = allowed ? parser(slice, allowed) : parser(slice);
      if (!parsed) { remaining = remaining.slice(idx + 8); continue; }
      // For parseMcp / parseBare: merge any out-of-band RAW:field blocks
      // sitting elsewhere in the same text. parseLua / parseJsonFence
      // are JSON-bounded so they never need the merge (RAW blocks are
      // matched by parseRawTool above). parseRawTool already merged.
      if (parser === parseMcp || parser === parseBare) {
        parsed = applyRawFields(parsed, extractRawBlocks(slice, allowed));
      }
      out.push(cleanLuaCall(parsed));
      remaining = slice.slice(Math.max(parsed.raw?.length || 0, 8));
    }
    return out;
  }

  function hasToolSignature(text) {
    const source = String(text || "");
    return source.includes(START_M) || LUA_START_RE.test(source) || /###RAW:[^#]+###/.test(source) || /###TOOL:[A-Za-z0-9_.-]+###/.test(source) || /\{[\s\S]*?"(?:tool|command|function)"\s*:\s*"[A-Za-z0-9_.-]+"/.test(source);
  }

  function hasOpenToolBlock(text) {
    const source = String(text || "");
    if (/###RAW:[^#]+###/.test(source) && !/###END_RAW###/.test(source)) return true;
    if (/###TOOL:[A-Za-z0-9_.-]+###/.test(source) && !/###END_TOOL###/.test(source)) return true;
    // A streaming ###LUA### block without its ###END_LUA### is still open:
    // without this, waitForReply verdicts premature `text` mid-stream and the
    // call is never dispatched (no chip). LUA_START_RE/LUA_END_RE are not
    // global so .test() is stateless here.
    if (LUA_START_RE.test(source) && !LUA_END_RE.test(source)) return true;
    const idx = source.lastIndexOf(START_M);
    if (idx >= 0) {
      const brace = source.indexOf("{", idx + START_M.length);
      if (brace >= 0 && !scanBalancedObject(source, brace).balanced) return true;
    }
    return false;
  }

  function toolNameFromText(text) {
    const m = String(text || "").match(/"(?:tool|command|function|name)"\s*:\s*"([A-Za-z0-9_./-]+)"/);
    if (m) return m[1];
    const raw = String(text || "").match(/###TOOL:([A-Za-z0-9_.-]+)###/);
    return raw ? raw[1] : null;
  }

  // ── nudge instrumentation (§2 step 6) ────────────────────────────────
  // Used by main.js to know when a "couldn't parse" message was actually
  // shown to the model, so the parser hardening can be measured before/after.
  const nudgeCounters = {
    malformed: 0,        // any parser path returned null while a tool block looked like one
    midStringTruncation: 0,
    unknownTool: 0,
    repairSuccess: 0
  };
  function recordNudge(reason) { nudgeCounters[reason] = (nudgeCounters[reason] || 0) + 1; }
  function recordRepair() { nudgeCounters.repairSuccess++; }
  function getNudgeStats() { return { ...nudgeCounters }; }
  function resetNudgeStats() { for (const k of Object.keys(nudgeCounters)) nudgeCounters[k] = 0; }

  // Augment extract() to record outcomes.
  const _origExtract = extract;
  function extractInstrumented(text) {
    const r = _origExtract(text);
    if (!r && hasToolSignature(text)) recordNudge("malformed");
    else if (r && r.repaired) recordRepair();
    return r;
  }

  const api = {
    START_M, END_M, LUA_START_RE, LUA_END_RE, DSML_RE, RAW_RE,
    findLuaStart, findLuaEnd, matchBrace, scanBalancedObject, extractRawBlocks,
    cleanLuaCall, stripCodeChrome, salvageCutOff,
    parseMcp, parseLua, parseJsonFence, parseBare, parseRawTool,
    extract: extractInstrumented, extractAll,
    parse: extractInstrumented, normalize, hasToolSignature, hasOpenToolBlock, toolNameFromText,
    repairJSONStringValues, getStringFields, getNudgeStats, resetNudgeStats,
    FALLBACK_STRING_FIELDS
  };
  root.ZSParse = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
