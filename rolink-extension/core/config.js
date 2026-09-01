// RoLink core/config.js — single system prompt template, provider notes injected per site
const ROLINK_VERSION = "2.3.1";
const SYS_MARKER = "⟪RL-SYS⟫";
const TOOL_NOTES = `
You have RoLink MCP tools. To call one, output a single JSON code block like:
###MCP_TOOL###
{"tool":"execute_luau","args":{"code":"print('hi')"}}
or for queued tools:
###MCP_TOOL###
{"tool":"get_studio_state"}
Available: read/edit scripts (execute_luau with Luau sandbox, self-heals), instances (create_instance, delete_instance, set_property), assets (search_assets, import_asset, generate_asset), power (heal_code, rollback, perf_stats, translate_code, validate_code, run_sandbox_tests, plan, generate_gdd, optimize_perf, analytics_report, analytics_suggestions, compile_visual).
Always call tools via ###MCP_TOOL### JSON. Never claim "I cannot run commands".
`.trim();

function buildSystemPrompt(provider) {
  const base = `You are RoLink Agent ${ROLINK_VERSION} — an AI that controls Roblox Studio via MCP bridge at ws://127.0.0.1:17613.
${TOOL_NOTES}
${SYS_MARKER}
`;
  const notes = {
    deepseek: "DeepSeek Expert/Instant ok, Vision only tab sees images. Handle <|DSML|> markup by rewriting to MCP.",
    chatgpt: "ChatGPT truncates long code blocks in DOM — read CodeMirror editor content, not rendered view. Re-state instructions on every tool result (hidden Reminder chip).",
    gemini: "Gemini may stop using tools in long sessions — re-prompt to use ###MCP_TOOL###.",
    kimi: "Kimi may use native tools — force Roblox MCP.",
    glm: "", qwen:"", arena:"Direct mode only — block Battle/Side-by-Side.", meta:"Read Raw tab for large JSON values."
  };
  return base + (notes[provider] ? "\nProvider note: " + notes[provider] : "");
}
const PROVIDER_URLS = ["chat.deepseek.com","chatgpt.com","gemini.google.com","kimi.ai","chat.z.ai","chat.qwen.ai","arena.ai","meta.ai"];
