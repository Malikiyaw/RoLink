// SPDX-License-Identifier: GPL-3.0-or-later
// RoLink parser: tolerant extraction, strict ambiguity rejection.
// Legacy ZeroScript-compatible shapes remain supported. RoLink additionally
// accepts a raw-field escape hatch:
//   ###MCP_TOOL###
//   {"tool":"set_script_content","args":{"path":"..."}}
//   ###RAW:content###
//   local value = "quotes and newlines are literal here"
//   ###END_RAW###

(function (root) {
  "use strict";

  const START_M = "###MCP_TOOL###";
  const RAW_RE = /###RAW:([A-Za-z0-9_.\[\]{}-]+)###([\s\S]*?)###END_RAW###/g;
  const TOOL_RAW_START_RE = /###TOOL:([A-Za-z0-9_.-]+)###/;
  const LUA_START_RE = /###LUA###|```lua/i;
  const DSML_RE = /<\|DSML\|>/g;

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
      rawFields: meta?.rawFields || {},
    };
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
    let currentKey = null;
    let expectingValue = false;

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
          currentKey = keyBefore(i);
          expectingValue = !!currentKey;
          inString = true;
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
        if (!structural && (expectingValue || currentKey)) {
          out += "\\\"";
          repaired = true;
          repairedFields++;
          continue;
        }
        out += c;
        inString = false;
        currentKey = null;
        expectingValue = false;
        continue;
      }
      out += c;
    }

    if (inString || !repaired) return null;
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

  function extractRawBlocks(text) {
    const rawFields = {};
    RAW_RE.lastIndex = 0;
    let match;
    while ((match = RAW_RE.exec(text))) {
      rawFields[match[1]] = match[2].replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    }
    return rawFields;
  }

  function applyRawFields(normalized, rawFields) {
    if (!normalized || !Object.keys(rawFields).length) return normalized;
    const args = { ...(normalized.args || {}) };
    for (const [field, value] of Object.entries(rawFields)) {
      if (field.endsWith("[]")) {
        const key = field.slice(0, -2);
        args[key] = Array.isArray(args[key]) ? [...args[key], value] : [value];
      } else {
        args[field] = value;
      }
    }
    return { ...normalized, args, rawFields };
  }

  function parseMcp(text) {
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
      const parsed = salvageObject(repaired.text);
      if (parsed?.value && (parsed.value.tool || parsed.value.command || parsed.value.function)) {
        return normalize(parsed.value, { type: "mcp", raw: chunk, repaired: true, repairReason: `${repaired.repairReason}+balanced-object-salvage` });
      }
    }
    const salvaged = salvageObject(chunk);
    if (salvaged?.value && (salvaged.value.tool || salvaged.value.command || salvaged.value.function)) {
      return normalize(salvaged.value, { type: "mcp", raw: chunk, repaired: true, repairReason: salvaged.repairReason });
    }
    return null;
  }

  function parseLua(text) {
    const start = text.search(LUA_START_RE);
    if (start < 0) return null;
    const marker = text.slice(start).match(LUA_START_RE);
    if (!marker) return null;
    const bodyStart = start + marker[0].length;
    const endMarker = text.indexOf("###END_LUA###", bodyStart);
    const fenceEnd = text.indexOf("```", bodyStart);
    const end = endMarker >= 0 ? endMarker : fenceEnd;
    if (end < 0) return null;
    const body = text.slice(bodyStart, end).replace(/^\s+|\s+$/g, "");
    return body ? normalize({ tool: "execute_luau", args: { code: body } }, { type: "lua", raw: body }) : null;
  }

  function parseRawTool(text) {
    const marker = text.match(TOOL_RAW_START_RE);
    if (!marker) return null;
    const tool = marker[1];
    const start = (marker.index || 0) + marker[0].length;
    const endMarker = text.indexOf("###END_TOOL###", start);
    const body = text.slice(start, endMarker >= 0 ? endMarker : text.length);
    const rawFields = extractRawBlocks(body);
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
    return applyRawFields({ tool, args, type: "raw-tool", raw: body, repaired: false, repairReason: null, rawFields }, rawFields);
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
    const m = text.match(/(\{[\s\S]*?"(?:tool|command|function)"\s*:\s*"[A-Za-z0-9_./-]+"[\s\S]*?\})/);
    if (!m) return null;
    const direct = tryJSON(m[1]);
    if (direct?.value) return normalize(direct.value, { type: "fn", raw: m[1] });
    const repaired = repairJSONStringValues(m[1]);
    if (!repaired) return null;
    const parsed = tryJSON(repaired.text);
    return parsed?.value ? normalize(parsed.value, { type: "fn", raw: m[1], repaired: true, repairReason: repaired.repairReason }) : null;
  }

  function extract(text) {
    const source = stripDSML(text);
    if (!source) return null;
    const rawTool = parseRawTool(source);
    if (rawTool) return rawTool;
    const mcp = parseMcp(source);
    if (mcp) return applyRawFields(mcp, extractRawBlocks(source));
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
      const slice = remaining.slice(idx);
      const parsed = parser(slice);
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

  const api = { START_M, extract, extractAll, parse: extract, normalize, hasToolSignature, hasOpenToolBlock, toolNameFromText, repairJSONStringValues, scanBalancedObject };
  root.ZSParse = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
