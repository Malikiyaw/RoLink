/**
 * S5 Sandbox — server-side static checks before enqueue, plus Luau harness generation for plugin tests
 */
const BLOCKED = [
  /os\.execute/i,
  /io\.popen/i,
  /require\s*\(\s*["']http/i,
  /getfenv|setfenv\s*\(\s*_G/i,
  /--\s*hydroxide/i,
];

const WARN_PATTERNS: Array<{ re: RegExp; msg: string }> = [
  { re: /while\s+true\s+do\s*[^]*?end/i, msg: "Infinite loop without wait() — may hang Studio" },
  { re: /Instance\.new\([^)]+\)\s*[^]*?Parent\s*=\s*nil/i, msg: "Instance created but never parented — will leak" },
  { re: /:GetService\("HttpService"\).*HttpGet/i, msg: "External Http request — ensure allowlist" },
];

export interface SandboxResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  sanitized: string;
}

export function validateLuau(code: string): SandboxResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (code.length > 50000) errors.push("code too large (max 50k)");
  if ((code.match(/\(/g) || []).length !== (code.match(/\)/g) || []).length) errors.push("unbalanced parentheses");
  // check end count roughly
  const opens = (code.match(/\b(function|if|for|while|do)\b/g) || []).length;
  const ends = (code.match(/\bend\b/g) || []).length;
  if (opens > ends + 2) warnings.push(`Possible missing 'end' (opens ${opens} > ends ${ends})`);

  for (const b of BLOCKED) if (b.test(code)) errors.push(`blocked pattern ${b}`);

  for (const w of WARN_PATTERNS) if (w.re.test(code)) warnings.push(w.msg);

  return { ok: errors.length === 0, errors, warnings, sanitized: code };
}

export function makeSandboxTestHarness(code: string, tests: string): string {
  // Wrap code + tests in pcall harness for plugin
  return `
local __code = [==[${code}]==]
local ok, fn = pcall(loadstring, __code)
if not ok or not fn then error("loadstring failed: "..tostring(fn)) end
local env = {print=print, math=math, string=string, table=table, Instance=Instance, game=game, workspace=workspace}
pcall(function() setfenv(fn, env) end)
local ok2, res = pcall(fn)
if not ok2 then error("exec failed: "..tostring(res)) end
-- tests
${tests}
print("[sandbox] tests passed")
return res
`.trim();
}
