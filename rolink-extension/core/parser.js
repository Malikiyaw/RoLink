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
  const RAW_RE = /###RAW:([A-Za-z0-9_.\[\]{}-]+)###([\s\S]*?)###END_RAW###/g;
  const TOOL_RAW_START_RE = /###TOOL:([A-Za-z0-9_.-]+)###/;
  const TOOL_RAW_END = "###END_TOOL###";
  const LUA_START_RE = /###LUA###|```lua/i;
  const LUA_END = "###END_LUA###";
  const DSML_RE = /<\|DSML\|>/g;

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
    return {
      tool,
      args,
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
    const start = text.search(LUA_START_RE);
    if (start < 0) return null;
    const marker = text.slice(start).match(LUA_START_RE);
    if (!marker) return null;
    const bodyStart = start + marker[0].length;
    const endMarker = text.indexOf(LUA_END, bodyStart);
    const fenceEnd = text.indexOf("```", bodyStart);
    const end = endMarker >= 0 ? endMarker : fenceEnd;
    if (end < 0) return null;
    const body = text.slice(bodyStart, end).replace(/^\s+|\s+$/g, "");
    return body ? normalize({ tool: "execute_luau", args: { code: body } }, { type: "lua", raw: body }) : null;
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
    if (rawTool) return rawTool;
    const mcp = parseMcp(source, allowed);
    if (mcp) return applyRawFields(mcp, extractRawBlocks(source, allowed));
    const lua = parseLua(source);
    if (lua) return lua;
    const json = parseJsonFence(source);
    if (json) return json;
    return parseBare(source);
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
      const parsed = allowed ? parser(slice, allowed) : parser(slice);
      if (!parsed) { remaining = remaining.slice(idx + 8); continue; }
      out.push(parsed);
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
    START_M, extract: extractInstrumented, extractAll,
    parse: extractInstrumented, normalize, hasToolSignature, hasOpenToolBlock, toolNameFromText,
    repairJSONStringValues, scanBalancedObject, getStringFields, getNudgeStats, resetNudgeStats,
    FALLBACK_STRING_FIELDS, parseBare, parseMcp, parseLua, parseRawTool
  };
  root.ZSParse = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
