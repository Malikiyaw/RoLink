// default-deny policy, allowlist handlers only
export const ALLOWED_TOOLS = new Set([
  "create_instance",
  "delete_instance",
  "set_property",
  "get_property",
  "run_code",
  "get_snapshot",
  "undo",
  "get_logs",
  "explain_code",
  "learning_mode",
  "adjust_difficulty",
  "set_difficulty_profile",
  "generate_sound",
  "generate_sound_pack",
  "play_sound",
  // Phase B S1-S10
  "heal_code",
  "rollback",
  "rollback_list",
  "perf_stats",
  "translate_code",
  "validate_code",
  "run_sandbox_tests",
  "plan",
  "get_context",
  "list_templates",
  "use_template",
  "create_template",
  "style_profile",
  "personalize_code",
  "generate_tests",
  "git_commit",
  "git_log",
  "review_code",
]);

export function isToolAllowed(tool: string): boolean {
  return ALLOWED_TOOLS.has(tool);
}

export function sanitizeCode(code: string): string {
  if (code.length > 50000) throw new Error("code too large (max 50k)");
  // block dangerous filesystem / os
  const blocked = [/os\.execute/i, /io\.popen/i, /require\s*\(\s*["']http/i];
  for (const re of blocked) if (re.test(code)) throw new Error(`blocked pattern ${re}`);
  return code;
}
