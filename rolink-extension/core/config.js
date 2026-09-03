// RoLink core/config.js — single system prompt template, provider notes injected per site
const ROLINK_VERSION = "5.2.0";
const SYS_MARKER = "⟪RL-SYS⟫";
const RESEND_MARKER = "⟪RL-RE⟫";
function toolCategory(name){
  const n=(name||"").toLowerCase();
  if(/script_search|script_grep|search_game_tree|inspect_instance|get_script_content|get_context_summary/.test(n)) return "read";
  if(/execute_luau|set_script_content|create_module|multi_edit|create_instance|set_properties|delete_instance|clone_instance|move_instance/.test(n)) return "edit";
  if(/get_snapshot|take_snapshot|get_instances|find_instance/.test(n)) return "inspect";
  if(/generate_asset|generate_terrain|create_model_from_table|generate_level|generate_quest/.test(n)) return "generate";
  if(/search_asset|import_asset|apply_material/.test(n)) return "asset";
  if(/create_ui|create_animation_track|play_animation|set_lighting|add_particle_emitter/.test(n)) return "visual";
  if(/run_tests|simulate_ticks|run_in_sandbox|playtest/.test(n)) return "test";
  return "tool";
}

// Pre-emptive format hint (§2 step 4). The set of code-bearing fields is
// generated from mcp-server/src/tools/registry.ts Zod schemas and exposed
// via window.ROLINK_CODE_FIELDS (set by core/code-fields.js). When that file
// is loaded we get an exhaustive, always-current list of fields that should
// use the RAW escape hatch; without it we fall back to a conservative
// hard-coded list so the prompt is still useful.
const _CF = (typeof window !== "undefined" && window.ROLINK_CODE_FIELDS) || null;
const _CODE_FIELDS = (_CF && _CF.codeLikeFields && _CF.codeLikeFields.length) ? _CF.codeLikeFields : [
  "code","content","new_text","old_text","new_string","old_string",
  "text","handlerCode","exports","source","handler","prompt",
  "newText","oldText","newString","oldString"
];
const RAW_FIELD_PROMPT = `
PREFERRED FORMAT — to avoid malformed-JSON failures, ALWAYS use the RAW escape hatch for any string field that contains source code, long text, or embedded quotes:
###MCP_TOOL###
{"tool":"<name>","args":{<other-fields>}}
###RAW:<field>###
<literal content — quotes and newlines are passed verbatim>
###END_RAW###
The list of fields that accept RAW blocks is generated from the registered tool schemas (${_CODE_FIELDS.length} fields). Use the RAW form for: ${_CODE_FIELDS.join(", ")}. You can also bundle multiple RAW fields with one block per field, or use the tool-scoped form ###TOOL:<name>### ... ###END_TOOL### for an entire tool call.
`.trim();
const TOOL_NOTES = `
You have RoLink MCP tools (111 total). To call one, output ONE JSON block:

###MCP_TOOL###
{"tool":"<name>","args":{...}}

Aliases: ###LUA### <luau> ###END_LUA### → execute_luau

${RAW_FIELD_PROMPT}

Groups:
- Core 1-7: get_instances, create_instance, set_properties, delete_instance, clone_instance, move_instance, find_instance
- Script 8-15: execute_luau, get_script_content, set_script_content, create_module, run_function, add_event_handler, remove_event_handler, get_global_variables
- Snapshot 16-18: take_snapshot, rollback, diff_snapshots
- Sandbox 19-22: run_in_sandbox, confirm_sandbox_apply, discard_sandbox, simulate_ticks
- Context 23-28: get_context_summary, get_function_signatures, get_property_value, get_all_properties, search_by_attribute, get_referenced_instances
- Dependency 29-33: resolve_path, ensure_path, get_dependency_graph, suggest_ordering, validate_command
- Perf 34-37: get_performance_stats, analyze_performance, set_performance_threshold, get_memory_usage
- Terrain 38-42: generate_terrain, set_terrain_region, place_parts, create_model_from_table, apply_material
- GUI 43-46: create_ui, set_ui_property, get_ui_tree, bind_ui_click
- Anim 47-50: create_animation_track, play_animation, set_lighting, add_particle_emitter
- DataStore 51-53: setup_datastore, get_datastore_value, set_datastore_value
- Team 54-57: export_session_log, replay_session, list_sessions, compare_sessions
- Templates 58-60: list_templates, apply_template, add_template
- Misc 61-64: get_time, send_notification, batch_queue, cancel_command
- Train 65: train_model
- Visual 66: compile_visual_graph
- Test 67-68: generate_test, run_tests
- Collab 69: session_users
- Assets 70-71: search_asset, import_asset
- Metrics 72-73: report_metrics, get_metrics
- Git 74-76: git_commit, git_log, git_rollback
- Predict 77: predict_bug
- Game 78-79: plan_game, execute_plan
- Review 80-81: review_code, refactor_code
- Gen 82: generate_asset
- Perf 83: optimize_performance
- Analytics 84-86: report_analytics, get_analytics, suggest_design
- Plugins 87-88: list_plugins, load_plugin
- Debug 89-93: set_breakpoint, remove_breakpoint, watch_variable, step_through, continue_execution
- Level 94: generate_level
- Projects 95-97: get_projects, switch_project, create_project
- Suggest 98: get_suggestions
- Playtest 99: run_playtest
- Archive 100-101: export_project, import_project
- Quest 102: generate_quest
- Economy 103-104: simulate_economy, suggest_balance
- Explain 105-106: explain_code, learning_mode
- DDA 107-108: adjust_difficulty, set_difficulty_profile
- Sound 109-111: generate_sound, generate_sound_pack, play_sound

For workspace explores use search_game_tree — ALWAYS emit ###MCP_TOOL### JSON.
Never describe the tool in prose — emit the JSON block.
For multi-step builds use batch_queue with {commands:[{tool,args}]} (max 20, no nesting).
Chain async jobs via IDs: pass generate_asset/generate_sound generationId to wait/run steps; never invent IDs.
`.trim();

function buildSystemPrompt(provider) {
  const base = `You are RoLink Agent ${ROLINK_VERSION} — an AI that controls Roblox Studio via MCP bridge at ws://127.0.0.1:17613.\n${TOOL_NOTES}\n${SYS_MARKER}\n`;
  const notes = {
    deepseek: "DeepSeek Expert/Instant ok, Vision only tab sees images. Handle <|DSML|> markup by rewriting to MCP.",
    chatgpt: "ChatGPT truncates long code blocks in DOM — read CodeMirror editor content, not rendered view. Re-state the RAW-block format below on every tool result so it doesn't drift.",
    gemini: "Gemini may stop using tools in long sessions — re-prompt to use ###MCP_TOOL### or RAW blocks.",
    kimi: "Kimi may use native tools — force Roblox MCP. Re-state RAW-block format periodically.",
    glm: "", qwen:"", arena:"Direct mode only — block Battle/Side-by-Side. Re-state RAW format on first reply.", meta:"Read Raw tab for large JSON values."
  };
  return base + (notes[provider] ? "\nProvider note: " + notes[provider] : "");
}
const PROVIDER_URLS = ["chat.deepseek.com","chatgpt.com","gemini.google.com","kimi.ai","chat.z.ai","chat.qwen.ai","arena.ai","meta.ai"];

// Session-drift detection (§4 step 1). Tracks turns-since-last-successful-
// tool-call per provider. When the gap exceeds DRIFT_TURNS the next
// "re-state instructions" is sent before the user's request, so the model
// doesn't burn a turn producing bad output. The pop-up panel reads
// `getDriftStats()` to display the running counters.
const DRIFT_TURNS = 4;
const drift = { turnsSinceSuccess: {}, lastNudgeTurn: {} };
function noteSuccessfulTool(provider){
  if(!provider) return;
  drift.turnsSinceSuccess[provider] = 0;
}
function noteTurn(provider){
  if(!provider) return;
  drift.turnsSinceSuccess[provider] = (drift.turnsSinceSuccess[provider] || 0) + 1;
}
function shouldReinject(provider){
  if(!provider) return false;
  return (drift.turnsSinceSuccess[provider] || 0) >= DRIFT_TURNS;
}
function noteReinject(provider){
  if(!provider) return;
  drift.lastNudgeTurn[provider] = drift.turnsSinceSuccess[provider] || 0;
}
function getDriftStats(){
  return {
    driftThreshold: DRIFT_TURNS,
    turnsSinceSuccess: { ...drift.turnsSinceSuccess },
    lastNudgeTurn: { ...drift.lastNudgeTurn }
  };
}

// Expose the drift API on window so the agent loop (main.js) can call it
// without re-importing the module. Same name is referenced in main.js.
if(typeof window !== "undefined"){
  window.__rolinkDrift = { noteTurn, noteSuccessfulTool, shouldReinject, noteReinject, getDriftStats, DRIFT_TURNS };
}
