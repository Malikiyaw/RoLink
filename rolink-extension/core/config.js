// RoLink core/config.js — single system prompt template, provider notes injected per site
const ROLINK_VERSION = "4.0.3";
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
const TOOL_NOTES = `
You have RoLink MCP tools (111 total). To call one, output ONE JSON block:

###MCP_TOOL###
{"tool":"<name>","args":{...}}

Aliases: ###LUA### <luau> ###END_LUA### → execute_luau

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

For workspace explores use search_game_tree — ALWAYS emit ###MCP_TOOL### JSON:
Example inspect workspace:
###MCP_TOOL###
{"tool":"find_instance","args":{"query":"Workspace","searchType":"name"}}
Or broad:
###MCP_TOOL###
{"tool":"get_instances","args":{"path":"workspace"}}
For scripts: {"tool":"get_script_content","args":{"path":"Workspace/Script"}}
Never describe the tool in prose — emit the JSON block.
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
