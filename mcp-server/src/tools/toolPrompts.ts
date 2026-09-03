// SPDX-License-Identifier: GPL-3.0-or-later
// mcp-server/src/tools/toolPrompts.ts — per-tool MASTER PROMPTS (source of truth).
//
// Why this file exists: registry.ts descriptions are one-liners (MCP spec
// ships them on every tools/list). The model needs forgeGUI-style guidance —
// when_to_use, exact arg formats, a copy-paste example, what the output means,
// and the top pitfalls — to produce Studio output that works first try.
// Full 111 inline in the system prompt would cost ~13k tokens/turn, so these
// prompts are served LAZILY: the extension looks one up only on the
// error-recovery path, and the server exposes GET /tools/:name/prompt.
// Shipped artifacts (see generated/tool-prompts.json +
// rolink-extension/core/tool-prompts.js, ~60KB one-time parse):
// `npm run generate:prompts` (scripts/generate-tool-prompts.ts).
// CI guard: descriptions in registry.ts must stay <= 200 chars; detail lives here.

export type ToolPrompt = {
  /** 1-2 sentences: when to call this, and what to use instead for nearby jobs. */
  when_to_use: string;
  /** Per-arg formats, required marks, defaults. Paths are Workspace-relative. */
  args_guide: string;
  /** Literal block the model can copy (###MCP_TOOL### JSON, or ###LUA###). */
  example_call: string;
  /** What comes back ({queued:true,id} vs immediate JSON) and the next step. */
  output: string;
  /** Top 2-3 failures seen live and how to avoid them. */
  pitfalls: string;
};

export const toolPrompts: Record<string, ToolPrompt> = {
  execute_luau: {
    when_to_use:
      "Run arbitrary Luau in Studio (spawn parts, wire logic, fix scripts). Prefer ###LUA### blocks over JSON so quotes never need escaping. For creating objects with geometry prefer generate_asset; for simple parts use this.",
    args_guide:
      "code* (Luau source; use game.Workspace, never just Workspace). datamodel_type auto-injected (Edit/Client/Server) — set explicitly only to override. timeoutMs default 20000.",
    example_call:
      '###LUA###\nlocal p = Instance.new("Part")\np.Size = Vector3.new(4, 1, 2)\np.Position = Vector3.new(0, 5, 0)\np.Parent = game.Workspace\n###END_LUA###',
    output:
      "Returns execution result text or ERROR. On ERROR, read the message, fix the code, retry exactly once.",
    pitfalls:
      "1) JSON-escaping bugs — use ###LUA###, never hand-escape quotes. 2) Yielding forever (while true without task.wait) hits timeout — keep loops bounded. 3) Nil parents — Parent to game.Workspace explicitly.",
  },
  get_instances: {
    when_to_use:
      "Explore the game tree: list children of a path. ALWAYS the first call for vague tasks ('make the zombie move' → find the zombie model first). Alias search_game_tree / inspect_instance / get_instance_tree all resolve here — emit get_instances.",
    args_guide: "path default 'workspace' (Workspace-relative, e.g. Workspace/Zombie). projectId optional.",
    example_call: '###MCP_TOOL###\n{"tool":"get_instances","args":{"path":"Workspace"}}',
    output: "Immediate JSON list of children (names, classes). Drill down with deeper paths.",
    pitfalls:
      "1) Emitting search_game_tree as its own tool — it is an alias, use get_instances. 2) Guessing deep paths — list top-down instead. 3) Case: 'Workspace' capital W in paths.",
  },
  find_instance: {
    when_to_use:
      "Search by name/class/attribute when you know a keyword ('zombie') but not the path. Use after get_instances returns too much, or before mutating an uncertain path.",
    args_guide: 'query* (e.g. "Zombie"). searchType name|class|attribute default name.',
    example_call: '###MCP_TOOL###\n{"tool":"find_instance","args":{"query":"Zombie"}}',
    output: "Immediate JSON matches with full paths — feed a match path into get/move/set calls.",
    pitfalls: "1) Over-broad queries ('Part') flood results — add searchType class. 2) Use returned exact paths verbatim downstream.",
  },
  create_instance: {
    when_to_use:
      "Create one new Instance (Part, Script, Folder, ...). For whole models use create_model_from_table; for UI use create_ui.",
    args_guide: "className* (e.g. Part). parent default workspace. name optional. properties optional map.",
    example_call:
      '###MCP_TOOL###\n{"tool":"create_instance","args":{"className":"Part","parent":"Workspace","name":"MyPart"}}',
    output: "{queued:true,id} → created async. Set properties with set_properties next if needed.",
    pitfalls: "1) Forgetting parent → check where it landed with get_instances. 2) Wrong className spelling fails validation — use exact Roblox class names.",
  },
  set_properties: {
    when_to_use:
      "Batch-update properties on an existing instance (move/resize/recolor). Read first with get_property_value if unsure of current values.",
    args_guide: "path* (Workspace-relative). properties* map, e.g. {Position: ..., Color: ...}.",
    example_call:
      '###MCP_TOOL###\n{"tool":"set_properties","args":{"path":"Workspace/MyPart","properties":{"Anchored":true}}}',
    output: "{queued:true,id} → applied async.",
    pitfalls: "1) Vector3/Color3 must be typed values, not strings. 2) resolve_path first if the path is uncertain.",
  },
  delete_instance: {
    when_to_use:
      "Permanently destroy ONE instance. For renames/moves use set_properties/move_instance. For experiments, snapshot first.",
    args_guide: "path* Workspace-relative (e.g. Workspace/OldPart).",
    example_call: '###MCP_TOOL###\n{"tool":"delete_instance","args":{"path":"Workspace/OldPart"}}',
    output: "{queued:true,id} → deleted async.",
    pitfalls: "1) IRREVERSIBLE without take_snapshot — snapshot first for anything non-trivial. 2) resolve_path first if unsure the path exists.",
  },
  move_instance: {
    when_to_use: "Reparent an instance (organize, move into a model/folder). Not for changing Position — use set_properties.",
    args_guide: "path* (what to move). newParent* (destination path).",
    example_call:
      '###MCP_TOOL###\n{"tool":"move_instance","args":{"path":"Workspace/MyPart","newParent":"Workspace/Models"}}',
    output: "{queued:true,id} → moved async.",
    pitfalls: "1) Destination must exist — ensure_path first. 2) Moving scripts can break connections — prefer in-place edits.",
  },
  clone_instance: {
    when_to_use: "Duplicate an instance (stamp out copies of a configured part/model).",
    args_guide: "path*. newName optional. parent optional (default same parent).",
    example_call:
      '###MCP_TOOL###\n{"tool":"clone_instance","args":{"path":"Workspace/MyPart","newName":"MyPart2"}}',
    output: "{queued:true,id} → cloned async.",
    pitfalls: "1) Clones inherit scripts/connections — check for duplicates firing twice. 2) Rename immediately to avoid name collisions.",
  },
  get_script_content: {
    when_to_use:
      "Read a script's full source BEFORE editing or debugging it ('why doesn't the zombie move' → read ZombieMovement first). Alias script_search resolves here.",
    args_guide: "path* (e.g. Workspace/Zombie/ZombieMovement).",
    example_call:
      '###MCP_TOOL###\n{"tool":"get_script_content","args":{"path":"Workspace/Zombie/ZombieMovement"}}',
    output: "Immediate script source text. Read it, then decide: set_script_content for rewrites, execute_luau for live tweaks.",
    pitfalls: "1) Never rewrite blind — read first. 2) Large scripts may truncate display; target sections via follow-up reads.",
  },
  set_script_content: {
    when_to_use:
      "Write a script's full source (rewrite/fix). For small live tweaks prefer execute_luau. Use ###RAW:content### for long code to avoid JSON escaping.",
    args_guide: "path*. content* (full new source). Use ###RAW:content### blocks for multi-line code.",
    example_call:
      '###MCP_TOOL###\n{"tool":"set_script_content","args":{"path":"Workspace/Zombie/ZombieMovement"}}\n###RAW:content###\n-- full fixed source here\n###END_RAW###',
    output: "{queued:true,id} → written async. Verify with get_script_content or playtest.",
    pitfalls:
      "1) This REPLACES the whole script — include unchanged parts. 2) take_snapshot first for non-trivial rewrites. 3) Raw quotes/newlines must go in ###RAW:content###, not JSON-escaped.",
  },
  create_module: {
    when_to_use: "Create a ModuleScript with exported functions (shared logic). For plain scripts use create_instance + set_script_content.",
    args_guide: "path*. exports* (Luau source of the module, must return a table).",
    example_call:
      '###MCP_TOOL###\n{"tool":"create_module","args":{"path":"ReplicatedStorage/MathUtil"}}\n###RAW:exports###\nlocal M = {}\nfunction M.add(a, b) return a + b end\nreturn M\n###END_RAW###',
    output: "{queued:true,id} → created async. Call via run_function.",
    pitfalls: "1) Module MUST return a table or require() fails. 2) Use ###RAW:exports### for the source.",
  },
  run_function: {
    when_to_use: "Call an exported ModuleScript function without touching Studio manually (test shared logic live).",
    args_guide: "path* (module). functionName*. args array default [].",
    example_call:
      '###MCP_TOOL###\n{"tool":"run_function","args":{"path":"ReplicatedStorage/MathUtil","functionName":"add","args":[1,2]}}',
    output: "Return value JSON. On ERROR, read it — usually wrong functionName or arg count.",
    pitfalls: "1) functionName is case-sensitive. 2) args must be a JSON array even for one arg.",
  },
  add_event_handler: {
    when_to_use: "Attach a Lua handler to an instance event (button clicks, Touched). For UI clicks prefer bind_ui_click.",
    args_guide: "path*. event* (e.g. Touched, Click). handlerCode* (Luau body). Use ###RAW:handlerCode### for multi-line.",
    example_call:
      '###MCP_TOOL###\n{"tool":"add_event_handler","args":{"path":"Workspace/MyPart","event":"Touched"}}\n###RAW:handlerCode###\nprint("touched!")\n###END_RAW###',
    output: "{queued:true,id} → attached async.",
    pitfalls: "1) Event names are case-sensitive (Touched not touched). 2) Keep handlers short — heavy logic belongs in a Script via set_script_content.",
  },
  take_snapshot: {
    when_to_use:
      "Save a full DataModel snapshot BEFORE any destructive/multi-step work (deletes, rewrites, terrain, batch_queue). Cheap insurance.",
    args_guide: "label optional (e.g. 'before-zombie-fix'). projectId default.",
    example_call: '###MCP_TOOL###\n{"tool":"take_snapshot","args":{"label":"before-fix"}}',
    output: "{queued:true,id} → snapshot stored. Recover with rollback, compare with diff_snapshots.",
    pitfalls: "1) Snapshot BEFORE the risky call, not after. 2) Label clearly — you will thank yourself at rollback time.",
  },
  rollback: {
    when_to_use: "Revert to a snapshot after something broke. Pair with take_snapshot (before) and diff_snapshots (verify).",
    args_guide: "projectId default. steps default 1, or snapshotId for a specific snapshot (mutually exclusive).",
    example_call: '###MCP_TOOL###\n{"tool":"rollback","args":{"steps":1}}',
    output: "JSON of rolled-back entries. Confirm state with get_instances after.",
    pitfalls: "1) steps vs snapshotId are exclusive — pass one. 2) Rollback reverts EVERYTHING since the snapshot, not one tool call.",
  },
  run_in_sandbox: {
    when_to_use:
      "Test risky code isolated BEFORE touching the live game (new AI logic, untrusted snippets). Promote with confirm_sandbox_apply, drop with discard_sandbox.",
    args_guide: "code* (Luau). Validated like execute_luau — same chrome/paren rules apply.",
    example_call: '###LUA###\n-- candidate logic here\n###END_LUA###',
    output: "{queued:true,id} → sandbox result. Then confirm_sandbox_apply or discard_sandbox.",
    pitfalls: "1) Sandbox has no live game state — reads of Workspace may differ. 2) Never skip this for code you have not run before.",
  },
  batch_queue: {
    when_to_use:
      "Run up to 20 independent commands in ONE call (scaffold a room: create 5 parts + set colors). Sequential fan-out — order is preserved.",
    args_guide: "commands* array of {tool,args}. Max 20, no nesting (a sub batch_queue is rejected).",
    example_call:
      '###MCP_TOOL###\n{"tool":"batch_queue","args":{"commands":[{"tool":"create_instance","args":{"className":"Part","name":"A"}},{"tool":"create_instance","args":{"className":"Part","name":"B"}}]}}',
    output: "{batched:N,succeeded:M,results:[...]} — inspect per-index results; fix only failures.",
    pitfalls: "1) Dependent steps (create THEN move the same part) must be ordered — results carry indices. 2) Keep batches independent; chains belong in sequence across turns.",
  },
  resolve_path: {
    when_to_use: "Check a path exists BEFORE mutating it (cheap guard before delete/set/move on uncertain paths).",
    args_guide: "path*.",
    example_call: '###MCP_TOOL###\n{"tool":"resolve_path","args":{"path":"Workspace/Zombie"}}',
    output: "Exists/missing verdict. Missing → ensure_path or correct the path.",
    pitfalls: "1) Always guard destructive calls this way. 2) Paths are case-sensitive.",
  },
  ensure_path: {
    when_to_use: "Create a missing folder path (organize before moving/creating). Idempotent — safe to call when unsure.",
    args_guide: "path* (folder path to guarantee).",
    example_call: '###MCP_TOOL###\n{"tool":"ensure_path","args":{"path":"Workspace/Models/Enemies"}}',
    output: "Path guaranteed. Then move_instance/create_instance into it.",
    pitfalls: "1) Only creates containers, not script contents. 2) Verify with get_instances after.",
  },
  generate_asset: {
    when_to_use:
      "Text-to-3D/texture for objects with real geometry (tower mesh, crates, props). Procedural, no API key. For simple cubes/cylinders use execute_luau + Instance.new instead.",
    args_guide: "prompt* (describe shape/material). kind model|texture default model.",
    example_call: '###MCP_TOOL###\n{"tool":"generate_asset","args":{"prompt":"medieval stone tower","kind":"model"}}',
    output: "{queued:true,id} + generationId → generation runs async; follow up (wait/job tools) with that exact ID.",
    pitfalls: "1) NEVER invent generation IDs — use the returned one verbatim. 2) Simple primitives do not need this tool. 3) Describe materials, not just names.",
  },
  remove_event_handler: {
    when_to_use: "Detach a previously added event handler (undo add_event_handler without touching the script).",
    args_guide: "path* (instance). event* (exact event name, e.g. Touched).",
    example_call: '###MCP_TOOL###\n{"tool":"remove_event_handler","args":{"path":"Workspace/MyPart","event":"Touched"}}',
    output: "{queued:true,id} → detached async.",
    pitfalls: "1) Event name must match exactly what was added. 2) Removing a handler the game still needs breaks behavior — verify first.",
  },
  get_global_variables: {
    when_to_use: "List shared globals (debug cross-script state, find where a value is set).",
    args_guide: "No required args; projectId optional.",
    example_call: '###MCP_TOOL###\n{"tool":"get_global_variables","args":{}}',
    output: "Immediate JSON list of globals. Read-only — mutate via execute_luau.",
    pitfalls: "1) Globals named _G vs getgenv differ by context — check the returned scope. 2) Empty result usually means scripts use locals (read the script instead).",
  },
  diff_snapshots: {
    when_to_use: "Compare two take_snapshot snapshots (verify what a risky change actually altered).",
    args_guide: "fromId* and toId* (snapshot IDs from take_snapshot/rollback outputs).",
    example_call: '###MCP_TOOL###\n{"tool":"diff_snapshots","args":{"fromId":"snap_1","toId":"snap_2"}}',
    output: "Immediate JSON diff of the two snapshots.",
    pitfalls: "1) IDs must both exist — list via rollback history first. 2) Snapshot BEFORE the change or there is nothing to compare.",
  },
  confirm_sandbox_apply: {
    when_to_use: "Promote tested sandbox code to the live game (the happy path after run_in_sandbox succeeds).",
    args_guide: "sandboxId* (ID returned by run_in_sandbox).",
    example_call: '###MCP_TOOL###\n{"tool":"confirm_sandbox_apply","args":{"sandboxId":"sbx_123"}}',
    output: "{queued:true,id} → applied to live game async.",
    pitfalls: "1) Use the exact sandboxId — never invent one. 2) Confirm only after reading the sandbox result.",
  },
  discard_sandbox: {
    when_to_use: "Throw away a sandbox attempt that failed testing (keeps the live game clean).",
    args_guide: "sandboxId*.",
    example_call: '###MCP_TOOL###\n{"tool":"discard_sandbox","args":{"sandboxId":"sbx_123"}}',
    output: "Immediate {discarded:true}. Live game untouched.",
    pitfalls: "1) Discarding is final for that sandboxId — confirm first if the result was borderline.",
  },
  simulate_ticks: {
    when_to_use: "Advance the game loop N seconds (let physics/scripts settle before inspecting results).",
    args_guide: "seconds default 1. Keep small (1-5) — long runs block the call.",
    example_call: '###MCP_TOOL###\n{"tool":"simulate_ticks","args":{"seconds":2}}',
    output: "{queued:true,id} → ticks ran. Inspect state after with get_instances/get_property_value.",
    pitfalls: "1) Large seconds values time out — chain small ticks instead. 2) For real playtesting use run_playtest.",
  },
  get_context_summary: {
    when_to_use: "Get a flattened whole-game overview (first pass on an unfamiliar place, or re-orient mid-session).",
    args_guide: "projectId default. maxDepth default 3 (raise only if the summary misses deep folders).",
    example_call: '###MCP_TOOL###\n{"tool":"get_context_summary","args":{"maxDepth":3}}',
    output: "Immediate JSON context tree. Follow up with get_instances on interesting branches.",
    pitfalls: "1) Deep maxDepth on huge places floods context — stay at 3. 2) Summaries go stale after mutations — re-fetch after big changes.",
  },
  get_function_signatures: {
    when_to_use: "List exported functions under a path (learn a ModuleScript API before calling run_function).",
    args_guide: "path default ReplicatedStorage.",
    example_call: '###MCP_TOOL###\n{"tool":"get_function_signatures","args":{"path":"ReplicatedStorage"}}',
    output: "Immediate JSON signatures (e.g. init(), update(dt)). Call via run_function.",
    pitfalls: "1) Signatures are static — verify live behavior with run_function. 2) Narrow path for large trees.",
  },
  get_property_value: {
    when_to_use: "Read ONE property (check Anchored, Position, Disabled before deciding a fix).",
    args_guide: "path* (instance). property* (exact Roblox property name, case-sensitive).",
    example_call: '###MCP_TOOL###\n{"tool":"get_property_value","args":{"path":"Workspace/Zombie/HumanoidRootPart","property":"Anchored"}}',
    output: "Immediate property value. Then set_properties to change it.",
    pitfalls: "1) Property names are case-sensitive (Anchored not anchored). 2) Script-local state is invisible here — read the script too.",
  },
  get_all_properties: {
    when_to_use: "Dump every property of an instance (unknown object, need full picture before editing).",
    args_guide: "path*.",
    example_call: '###MCP_TOOL###\n{"tool":"get_all_properties","args":{"path":"Workspace/MyPart"}}',
    output: "Immediate JSON property map.",
    pitfalls: "1) Verbose on complex instances — prefer get_property_value when you know the key. 2) Values reflect Edit mode unless playtesting.",
  },
  search_by_attribute: {
    when_to_use: "Find instances by attribute key/value (locate all zombies tagged Team=Enemy). Alias script_grep resolves here.",
    args_guide: "attribute* (key). value optional (omit to match any value).",
    example_call: '###MCP_TOOL###\n{"tool":"search_by_attribute","args":{"attribute":"Team","value":"Enemy"}}',
    output: "Immediate JSON matches with paths.",
    pitfalls: "1) Attributes ≠ properties — for built-ins use find_instance/get_property_value. 2) Omit value for a broad sweep, add it to narrow.",
  },
  get_referenced_instances: {
    when_to_use: "Find what a script references (which instances a buggy script touches).",
    args_guide: "path* (script path).",
    example_call: '###MCP_TOOL###\n{"tool":"get_referenced_instances","args":{"path":"Workspace/Zombie/ZombieMovement"}}',
    output: "Immediate JSON referenced paths.",
    pitfalls: "1) Dynamic requires (built at runtime) may not appear. 2) Pair with get_script_content for the full story.",
  },
  get_dependency_graph: {
    when_to_use: "Build the require/dependency tree (plan safe edit order, find circular deps).",
    args_guide: "projectId default.",
    example_call: '###MCP_TOOL###\n{"tool":"get_dependency_graph","args":{}}',
    output: "Immediate JSON graph. Order work with suggest_ordering.",
    pitfalls: "1) Graph is structural, not runtime — dynamic requires are missed. 2) Re-fetch after adding modules.",
  },
  suggest_ordering: {
    when_to_use: "Sort creation steps so dependencies exist first (feed it the item list before a batch_queue scaffold).",
    args_guide: "items* (array of names/paths). Pure local — works offline.",
    example_call: '###MCP_TOOL###\n{"tool":"suggest_ordering","args":{"items":["Zombie","Zombie/Humanoid","Workspace"]}}',
    output: "Immediate {ordered:[...]}. Execute in that order.",
    pitfalls: "1) Input must be an array of strings. 2) It sorts names only — real dependency cycles still need manual untangling.",
  },
  validate_command: {
    when_to_use: "Check a tool name is allowed before emitting it (recover from unknown-tool errors). Pure local.",
    args_guide: "tool* (name to check). args optional (passed through for future checks).",
    example_call: '###MCP_TOOL###\n{"tool":"validate_command","args":{"tool":"execute_luau"}}',
    output: "Immediate {tool, allowed:true/false}.",
    pitfalls: "1) Allowed ≠ will-succeed — Studio state still matters. 2) Dynamic StudioMCP tools (list_roblox_studios) report allowed by name rule.",
  },
  get_performance_stats: {
    when_to_use: "See aggregated tool timings (find what's slow in this session).",
    args_guide: "projectId optional. limit default 20.",
    example_call: '###MCP_TOOL###\n{"tool":"get_performance_stats","args":{"limit":20}}',
    output: "Immediate stats + recent timings JSON.",
    pitfalls: "1) Stats cover bridge calls, not in-Studio FPS — use report_metrics for gameplay FPS. 2) Empty stats just means a fresh session.",
  },
  analyze_performance: {
    when_to_use: "Static performance review of Luau code (catch expensive patterns before running).",
    args_guide: "code* (Luau source; RAW block recommended for long code).",
    example_call: '###MCP_TOOL###\n{"tool":"analyze_performance","args":{"code":"for i=1,100000 do Instance.new(\\"Part\\").Parent = game.Workspace end"}}',
    output: "Immediate {validate, review} JSON with warnings.",
    pitfalls: "1) Static only — real bottlenecks need run_playtest metrics. 2) Fix the highest-severity warnings first.",
  },
  set_performance_threshold: {
    when_to_use: "Set the global slow-call threshold in ms (tune SLOW-tag sensitivity). Pure local.",
    args_guide: "thresholdMs default 100.",
    example_call: '###MCP_TOOL###\n{"tool":"set_performance_threshold","args":{"thresholdMs":200}}',
    output: "Immediate {thresholdMs, applied:true}.",
    pitfalls: "1) Too low floods warnings; too high hides real slowdowns. 2) Session-scoped — resets on bridge restart.",
  },
  get_memory_usage: {
    when_to_use: "Check bridge queue/memory footprint (diagnose backlog when calls feel stuck). Pure local.",
    args_guide: "projectId optional.",
    example_call: '###MCP_TOOL###\n{"tool":"get_memory_usage","args":{}}',
    output: "Immediate {queueDepth}. High depth → wait or cancel_command.",
    pitfalls: "1) This is bridge-side depth, not Studio memory. 2) Persistent backlog usually means Studio MCP is down.",
  },
  generate_terrain: {
    when_to_use: "Generate heightmap/noise terrain for outdoor maps (fast landscape base). Detail with set_terrain_region after.",
    args_guide: "size default 512. seed default 12345 (same seed = same terrain).",
    example_call: '###MCP_TOOL###\n{"tool":"generate_terrain","args":{"size":512,"seed":12345}}',
    output: "{queued:true,id} → terrain generated async. take_snapshot first — terrain gen is destructive.",
    pitfalls: "1) Destroys existing terrain — snapshot first. 2) Reuse the seed to reproduce the exact map.",
  },
  set_terrain_region: {
    when_to_use: "Modify one terrain bounding box (flatten a build pad, paint material).",
    args_guide: "min*/max* ([x,y,z] triples). material default Grass.",
    example_call: '###MCP_TOOL###\n{"tool":"set_terrain_region","args":{"min":[0,0,0],"max":[64,8,64],"material":"Grass"}}',
    output: "{queued:true,id} → region applied async.",
    pitfalls: "1) min must be strictly below max on every axis. 2) Material names are case-sensitive.",
  },
  place_parts: {
    when_to_use: "Stamp patterned parts (grid of pillars, circle of torches, line of fence).",
    args_guide: "pattern grid|circle|line default grid. count default 10. parent default workspace.",
    example_call: '###MCP_TOOL###\n{"tool":"place_parts","args":{"pattern":"circle","count":12}}',
    output: "{queued:true,id} → parts placed async.",
    pitfalls: "1) Big counts flood the place — start small, then batch more. 2) ensure_path first if parent is custom.",
  },
  create_model_from_table: {
    when_to_use: "Build a whole model from a parts spec in ONE call (furniture, vehicles, structures).",
    args_guide: "name*. parts* array of {className, properties?}. parent default workspace.",
    example_call: '###MCP_TOOL###\n{"tool":"create_model_from_table","args":{"name":"Chair","parts":[{"className":"Part","properties":{"Size":"4,1,4"}}]}}',
    output: "{queued:true,id} → model built async.",
    pitfalls: "1) Every part needs a valid className — one typo fails the batch. 2) Keep properties to primitives (numbers/strings/bools).",
  },
  apply_material: {
    when_to_use: "Apply a material to a region/selection (retheme wood→metal).",
    args_guide: "material* (e.g. Wood, Metal, Grass). region optional (omit = current selection).",
    example_call: '###MCP_TOOL###\n{"tool":"apply_material","args":{"material":"Wood"}}',
    output: "{queued:true,id} → applied async.",
    pitfalls: "1) Material names are case-sensitive. 2) Scope the region — blanket applies are hard to undo without a snapshot.",
  },
  create_ui: {
    when_to_use: "Build a ScreenGui hierarchy (menus, HUDs, buttons). Attach behavior with bind_ui_click after.",
    args_guide: "name default MyGui. elements optional array of UI descriptors.",
    example_call: '###MCP_TOOL###\n{"tool":"create_ui","args":{"name":"MainMenu"}}',
    output: "{queued:true,id} → UI created async. Inspect with get_ui_tree.",
    pitfalls: "1) UI lives in PlayerGui/StarterGui paths — verify with get_ui_tree. 2) Build structure first, behavior second.",
  },
  set_ui_property: {
    when_to_use: "Change one UI property (text, color, visibility, size).",
    args_guide: "path* (UI element). property* (exact name). value* (typed value, not always string).",
    example_call: '###MCP_TOOL###\n{"tool":"set_ui_property","args":{"path":"Players/LocalPlayer/PlayerGui/MainMenu/Title","property":"Text","value":"Play!"}}',
    output: "{queued:true,id} → applied async.",
    pitfalls: "1) Property names are case-sensitive. 2) UDim2/Color3 need typed values — check get_ui_tree output format first.",
  },
  get_ui_tree: {
    when_to_use: "List UI elements (find button paths before binding or editing).",
    args_guide: "No required args; projectId optional.",
    example_call: '###MCP_TOOL###\n{"tool":"get_ui_tree","args":{}}',
    output: "Immediate UI tree JSON with paths.",
    pitfalls: "1) Player-specific UI needs a running game — empty in Edit is normal. 2) Copy paths verbatim downstream.",
  },
  bind_ui_click: {
    when_to_use: "Attach a click handler to a UI button (wire menu buttons to actions).",
    args_guide: "path* (button). handlerCode* (Luau; RAW block for multi-line).",
    example_call: '###MCP_TOOL###\n{"tool":"bind_ui_click","args":{"path":"Players/LocalPlayer/PlayerGui/MainMenu/Play"}}\n###RAW:handlerCode###\nprint("play pressed")\n###END_RAW###',
    output: "{queued:true,id} → bound async.",
    pitfalls: "1) Path must be the button itself, not its ScreenGui. 2) Keep handler short; heavy logic goes in a Script.",
  },
  create_animation_track: {
    when_to_use: "Define a keyframed animation track (walk cycles, emotes, zombie shamble).",
    args_guide: "name*. keyframes* array.",
    example_call: '###MCP_TOOL###\n{"tool":"create_animation_track","args":{"name":"Shamble","keyframes":[]}}',
    output: "{queued:true,id} → track created. Play with play_animation.",
    pitfalls: "1) Empty keyframes create a valid-but-motionless track — supply real frames. 2) Target rig must have a Humanoid/Animator.",
  },
  play_animation: {
    when_to_use: "Play an animation on a character (test a track, trigger an emote).",
    args_guide: "target default workspace. animationId optional (omit = default/selected track).",
    example_call: '###MCP_TOOL###\n{"tool":"play_animation","args":{"target":"Workspace/Zombie"}}',
    output: "{queued:true,id} → playing async.",
    pitfalls: "1) Needs a rig with Humanoid + Animator or nothing visibly happens. 2) In Edit mode animations may not render — run_playtest to verify.",
  },
  set_lighting: {
    when_to_use: "Adjust Lighting service (day/night mood, fog, horror zombie vibe).",
    args_guide: "properties* map (e.g. {ClockTime: 0, FogEnd: 200}).",
    example_call: '###MCP_TOOL###\n{"tool":"set_lighting","args":{"properties":{"ClockTime":0,"Ambient":"20,20,20"}}}',
    output: "{queued:true,id} → applied async.",
    pitfalls: "1) Values are typed (numbers, not strings). 2) Snapshot-worthy: lighting changes affect every screenshot/test after.",
  },
  add_particle_emitter: {
    when_to_use: "Attach particles to a part (torches, portals, zombie aura).",
    args_guide: "path* (part). properties optional (Rate, Texture, ...).",
    example_call: '###MCP_TOOL###\n{"tool":"add_particle_emitter","args":{"path":"Workspace/Torch"}}',
    output: "{queued:true,id} → emitter attached async.",
    pitfalls: "1) Path must be a BasePart, not a Model. 2) Rate too high tanks FPS — start low, check run_playtest.",
  },
  setup_datastore: {
    when_to_use: "Define a DataStore schema (coins, inventory, save layout) before reading/writing values.",
    args_guide: "name* (store). schema* (field map).",
    example_call: '###MCP_TOOL###\n{"tool":"setup_datastore","args":{"name":"PlayerData","schema":{"coins":"number"}}}',
    output: "Immediate {datastore, schema} echo. Then get/set_datastore_value.",
    pitfalls: "1) Schema is a local contract — Studio DataStores enforce nothing. 2) Keep key types consistent or reads surprise you.",
  },
  get_datastore_value: {
    when_to_use: "Read one DataStore key (check a player's coins).",
    args_guide: "store* and key*.",
    example_call: '###MCP_TOOL###\n{"tool":"get_datastore_value","args":{"store":"PlayerData","key":"coins_123"}}',
    output: "Value JSON (or missing-key notice).",
    pitfalls: "1) Wrong store/key spelling reads a different (empty) slot — verify with setup first. 2) Values are untyped JSON — validate before math.",
  },
  set_datastore_value: {
    when_to_use: "Write one DataStore key (grant coins, save progress).",
    args_guide: "store*, key*, value* (JSON value).",
    example_call: '###MCP_TOOL###\n{"tool":"set_datastore_value","args":{"store":"PlayerData","key":"coins_123","value":100}}',
    output: "{queued:true,id} → written async.",
    pitfalls: "1) Overwrites unconditionally — read first for currencies. 2) Keep values small and JSON-typed.",
  },
  export_session_log: {
    when_to_use: "Export recent session events (review what the agent did, debug a bad run).",
    args_guide: "projectId default. limit default 100.",
    example_call: '###MCP_TOOL###\n{"tool":"export_session_log","args":{"limit":50}}',
    output: "Immediate JSON event log.",
    pitfalls: "1) Large limits flood context — stay under 100. 2) Logs are session-scoped, not place state.",
  },
  replay_session: {
    when_to_use: "Re-examine a past session's first steps (understand how a result was reached).",
    args_guide: "sessionId*.",
    example_call: '###MCP_TOOL###\n{"tool":"replay_session","args":{"sessionId":"sess_1"}}',
    output: "Immediate session excerpt JSON. Read-only — it does not re-execute.",
    pitfalls: "1) Replay shows history, not live state — verify against the place. 2) Need the sessionId from list_sessions first.",
  },
  list_sessions: {
    when_to_use: "List recent sessions (find a sessionId to replay or compare). Pure local.",
    args_guide: "limit default 20.",
    example_call: '###MCP_TOOL###\n{"tool":"list_sessions","args":{"limit":10}}',
    output: "Immediate session-ID list.",
    pitfalls: "1) IDs are opaque — match by recency. 2) Old sessions may be pruned.",
  },
  compare_sessions: {
    when_to_use: "Diff two sessions by event counts (did the retry behave differently?).",
    args_guide: "a* and b* (session IDs).",
    example_call: '###MCP_TOOL###\n{"tool":"compare_sessions","args":{"a":"sess_1","b":"sess_2"}}',
    output: "Immediate {aCount, bCount} comparison.",
    pitfalls: "1) Counts only — drill into export_session_log for details. 2) Both IDs must exist.",
  },
  list_templates: {
    when_to_use: "Browse reusable templates (scaffold common builds instead of hand-placing).",
    args_guide: "category optional (omit = all).",
    example_call: '###MCP_TOOL###\n{"tool":"list_templates","args":{}}',
    output: "Immediate template list with IDs. Apply with apply_template.",
    pitfalls: "1) Template contents vary — read before applying to a live place. 2) Snapshot before bulk applies.",
  },
  apply_template: {
    when_to_use: "Apply a listed template into the place (fast scaffold).",
    args_guide: "id* (template ID from list_templates).",
    example_call: '###MCP_TOOL###\n{"tool":"apply_template","args":{"id":"obby-base"}}',
    output: "{applied:true, template} (+queued run_code when the template carries code).",
    pitfalls: "1) Applies immediately — snapshot first. 2) Unknown IDs error — list first, never invent IDs.",
  },
  add_template: {
    when_to_use: "Save your own build as a reusable template (capture a good pattern for later).",
    args_guide: "id* and name*. description/category/code optional (defaults provided).",
    example_call: '###MCP_TOOL###\n{"tool":"add_template","args":{"id":"my-door","name":"Sliding Door"}}',
    output: "Immediate created-template echo.",
    pitfalls: "1) IDs must be unique — reusing one overwrites. 2) Include the code or the template is just a label.",
  },
  get_time: {
    when_to_use: "Current UTC time/epoch (timestamps, ordering debug events). Pure local, works offline.",
    args_guide: "No args.",
    example_call: '###MCP_TOOL###\n{"tool":"get_time","args":{}}',
    output: "Immediate {time, epoch}.",
    pitfalls: "1) UTC, not Studio time — convert for in-game clocks. 2) No project context attached.",
  },
  send_notification: {
    when_to_use: "Pop a Studio notification (signal the user a long job finished).",
    args_guide: "message*. type info|warn|error default info.",
    example_call: '###MCP_TOOL###\n{"tool":"send_notification","args":{"message":"Tower built","type":"info"}}',
    output: "{queued:true,id} → shown async.",
    pitfalls: "1) Notifications are ephemeral — don't use for errors the user must act on; say it in chat too. 2) Keep messages one line.",
  },
  cancel_command: {
    when_to_use: "Cancel a queued command by ID (stop a runaway batch or stale enqueue).",
    args_guide: "id* (queue command ID).",
    example_call: '###MCP_TOOL###\n{"tool":"cancel_command","args":{"id":"cmd_123"}}',
    output: "Immediate {cancelled:true/false, id}.",
    pitfalls: "1) Only queued (not yet claimed) commands can cancel — in-flight Studio work cannot be recalled. 2) Use exact IDs from batch/queue outputs.",
  },
  train_model: {
    when_to_use: "Build a style profile from the codebase (match indent/WaitForChild habits in generated code). Offline, no key.",
    args_guide: "projectId default.",
    example_call: '###MCP_TOOL###\n{"tool":"train_model","args":{}}',
    output: "Immediate {trained:true, profile}. personalize() uses it automatically after.",
    pitfalls: "1) Needs command history to learn from — empty projects give a default profile. 2) Retrain after big refactors.",
  },
  compile_visual_graph: {
    when_to_use: "Compile a node graph {nodes, edges} to Luau (visual-scripted logic → runnable code).",
    args_guide: "graph* ({nodes[], edges[]}).",
    example_call: '###MCP_TOOL###\n{"tool":"compile_visual_graph","args":{"graph":{"nodes":[],"edges":[]}}}',
    output: "{luau, warnings} — clean compiles also enqueue run_code automatically.",
    pitfalls: "1) Warnings mean partial compile — read them before trusting output. 2) Disconnected nodes generate dead code.",
  },
  generate_test: {
    when_to_use: "Generate a test script + harness for Luau code (verify logic before live-apply).",
    args_guide: "code* (the code under test; RAW block for long code).",
    example_call: '###MCP_TOOL###\n{"tool":"generate_test","args":{"code":"local function add(a,b) return a+b end"}}',
    output: "Immediate {tests, harness} JSON. Run via run_tests.",
    pitfalls: "1) Generated tests assert current behavior — including bugs. Read them. 2) Pure functions test best; Studio-coupled code needs run_playtest.",
  },
  run_tests: {
    when_to_use: "Queue the test suite (run what generate_test produced).",
    args_guide: "projectId default.",
    example_call: '###MCP_TOOL###\n{"tool":"run_tests","args":{}}',
    output: "{queued:true,id} → results async.",
    pitfalls: "1) No tests generated = nothing runs — generate_test first. 2) Flaky timing tests fail intermittently; prefer deterministic asserts.",
  },
  session_users: {
    when_to_use: "List active collaborators on the project (who else is in this session). Pure local.",
    args_guide: "projectId default.",
    example_call: '###MCP_TOOL###\n{"tool":"session_users","args":{}}',
    output: "Immediate collaborator list (often empty solo).",
    pitfalls: "1) Empty is normal solo — not an error. 2) Not a permission system; anyone with the place can edit.",
  },
  search_asset: {
    when_to_use: "Search the Roblox library by keyword (find a zombie model instead of building one).",
    args_guide: "keyword*. limit default 8. category optional.",
    example_call: '###MCP_TOOL###\n{"tool":"search_asset","args":{"keyword":"zombie","limit":5}}',
    output: "Immediate asset list with IDs. Import with import_asset.",
    pitfalls: "1) Quality varies — inspect after import. 2) Prefer small limits; huge lists flood context.",
  },
  import_asset: {
    when_to_use: "Import a library asset by ID into the place (the follow-up to search_asset).",
    args_guide: "assetId* (number from search_asset). parent default workspace.",
    example_call: '###MCP_TOOL###\n{"tool":"import_asset","args":{"assetId":123456}}',
    output: "{queued:true,id} → imported async. Verify with get_instances.",
    pitfalls: "1) assetId must be a number from search results — never invent IDs. 2) Imports can carry scripts — read them before trusting.",
  },
  report_metrics: {
    when_to_use: "Ingest one gameplay sample (deaths/min, FPS, players) for balancing work.",
    args_guide: "projectId default + any of deathsPerMinute/avgFPS/killDeathRatio/completionTimeSec/coinsPerMin/activePlayers.",
    example_call: '###MCP_TOOL###\n{"tool":"report_metrics","args":{"avgFPS":55,"activePlayers":4}}',
    output: "Immediate ingest receipt. Read back with get_metrics; tune with suggest_balance.",
    pitfalls: "1) One sample proves nothing — collect several across playtests. 2) Field names must match exactly or the sample is ignored.",
  },
  get_metrics: {
    when_to_use: "Read recent gameplay metric samples (check FPS/deaths before balancing).",
    args_guide: "projectId default. limit default 20.",
    example_call: '###MCP_TOOL###\n{"tool":"get_metrics","args":{"limit":10}}',
    output: "Immediate recent-samples JSON.",
    pitfalls: "1) Empty = no samples reported yet — report_metrics first. 2) Stale samples mislead — check timestamps.",
  },
  git_commit: {
    when_to_use: "Commit current bridge-side state with a message (checkpoint before risky refactors).",
    args_guide: "message*. files optional (omit = all).",
    example_call: '###MCP_TOOL###\n{"tool":"git_commit","args":{"message":"zombie AI checkpoint"}}',
    output: "Immediate commit result JSON. History via git_log; revert via git_rollback.",
    pitfalls: "1) This versions bridge state, not the .rbxl place — snapshot the place separately. 2) Write real messages; 'fix' helps nobody later.",
  },
  git_log: {
    when_to_use: "Show commit history (find a checkpoint hash to roll back to).",
    args_guide: "limit default 10.",
    example_call: '###MCP_TOOL###\n{"tool":"git_log","args":{"limit":10}}',
    output: "Immediate history text.",
    pitfalls: "1) Hashes are bridge-side — pair with take_snapshot labels for place state. 2) Large limits flood context.",
  },
  git_rollback: {
    when_to_use: "Revert bridge state to a commit (undo a bad refactor).",
    args_guide: "commit* (hash from git_log).",
    example_call: '###MCP_TOOL###\n{"tool":"git_rollback","args":{"commit":"abc123"}}',
    output: "{rollbackTo} + queued undo. Verify live state after.",
    pitfalls: "1) Does not touch the .rbxl place — use rollback for place state. 2) Never invent hashes — copy from git_log.",
  },
  predict_bug: {
    when_to_use: "Predict likely bugs in Luau before running it (cheap pre-check for AI-written code).",
    args_guide: "code* (RAW block for long code).",
    example_call: '###MCP_TOOL###\n{"tool":"predict_bug","args":{"code":"game.Workspace.Part:Destroy()"}}',
    output: "Immediate {predictions, risk:high|medium|low}.",
    pitfalls: "1) Heuristic, not proof — high risk means read carefully, not auto-reject. 2) Low risk is not a correctness guarantee.",
  },
  plan_game: {
    when_to_use: "Turn a one-line idea into a structured game design doc (start every new game here). Offline.",
    args_guide: "prompt* (game idea in plain words).",
    example_call: '###MCP_TOOL###\n{"tool":"plan_game","args":{"prompt":"zombie survival with day/night waves"}}',
    output: "Immediate GDD JSON. Build it with execute_plan.",
    pitfalls: "1) A plan is not a build — execute_plan still needed. 2) Vague prompts give vague plans; include genre + core loop.",
  },
  execute_plan: {
    when_to_use: "Queue the build steps of a plan_game design (idea → queued scaffolding).",
    args_guide: "prompt* (same idea/description).",
    example_call: '###MCP_TOOL###\n{"tool":"execute_plan","args":{"prompt":"zombie survival with day/night waves"}}',
    output: "{plan, queued:[ids]} — steps enqueue as run_code. Inspect each result.",
    pitfalls: "1) Auto-queued code is draft quality — review before keeping. 2) Large plans flood the queue — confirm each step's output.",
  },
  review_code: {
    when_to_use: "Static code review of Luau (issues + refactoring plan before you edit).",
    args_guide: "code* (RAW block for long code).",
    example_call: '###MCP_TOOL###\n{"tool":"review_code","args":{"code":"while true do print(1) end"}}',
    output: "Immediate review + refactoringPlan JSON.",
    pitfalls: "1) Reviews flag style too — fix high severity first. 2) Apply via refactor_code or set_script_content, not by hand-copying.",
  },
  refactor_code: {
    when_to_use: "Auto-apply safe refactors to Luau (cleanup after review_code). Queues the fixed code.",
    args_guide: "code*.",
    example_call: '###MCP_TOOL###\n{"tool":"refactor_code","args":{"code":"local x=1"}}',
    output: "Heal report JSON + queued run_code of fixed code.",
    pitfalls: "1) take_snapshot first — refactors can change behavior. 2) Read the heal report; 'fixed' code still needs a playtest.",
  },
  optimize_performance: {
    when_to_use: "Auto-optimize a snapshot/project (reduce part counts, flag hotspots).",
    args_guide: "projectId default. snapshot optional (omit = current).",
    example_call: '###MCP_TOOL###\n{"tool":"optimize_performance","args":{}}',
    output: "Immediate optimization report JSON.",
    pitfalls: "1) Optimizations trade fidelity for speed — verify visuals after. 2) Snapshot first; optimization is a mutation.",
  },
  report_analytics: {
    when_to_use: "Log one analytics event (button clicks, purchases) for later design review.",
    args_guide: "projectId default. event?, value?, metadata? as needed.",
    example_call: '###MCP_TOOL###\n{"tool":"report_analytics","args":{"event":"play_pressed","value":1}}',
    output: "Immediate analytics report state. Summaries via get_analytics.",
    pitfalls: "1) Event names must be consistent or reports fragment. 2) One event is noise — log flows, then read get_analytics.",
  },
  get_analytics: {
    when_to_use: "Read analytics summaries (what are players actually doing?).",
    args_guide: "projectId default.",
    example_call: '###MCP_TOOL###\n{"tool":"get_analytics","args":{}}',
    output: "Immediate summary JSON.",
    pitfalls: "1) Empty until report_analytics is used. 2) Summaries lag real-time play.",
  },
  suggest_design: {
    when_to_use: "Get data-backed design suggestions (tune difficulty, pacing, economy).",
    args_guide: "projectId default (uses stored analytics/metrics).",
    example_call: '###MCP_TOOL###\n{"tool":"suggest_design","args":{}}',
    output: "Immediate suggestions JSON.",
    pitfalls: "1) Garbage in, garbage out — needs real metrics first. 2) Suggestions are advisory; apply via real build tools.",
  },
  list_plugins: {
    when_to_use: "List loaded bridge plugins (check what's available before load_plugin). Pure local.",
    args_guide: "No args.",
    example_call: '###MCP_TOOL###\n{"tool":"list_plugins","args":{}}',
    output: "Immediate {plugins, count}.",
    pitfalls: "1) These are bridge-side plugins, not Studio plugins. 2) Count rarely changes mid-session.",
  },
  load_plugin: {
    when_to_use: "Load/reload a bridge plugin by name, optionally with code (extend the bridge live).",
    args_guide: "name*. code optional (validated as Luau when provided).",
    example_call: '###MCP_TOOL###\n{"tool":"load_plugin","args":{"name":"myHelper"}}',
    output: "Immediate {loaded:true}. With bad code → validation error instead.",
    pitfalls: "1) Untrusted code runs bridge-side — review before loading. 2) Name must match a known plugin for codeless loads.",
  },
  set_breakpoint: {
    when_to_use: "Set a debug breakpoint in a script (pause live execution to inspect).",
    args_guide: "path* and line* (1-based). condition optional.",
    example_call: '###MCP_TOOL###\n{"tool":"set_breakpoint","args":{"path":"Workspace/Zombie/AI","line":42}}',
    output: "{queued:true,id} → breakpoint set async. Step with step_through, resume with continue_execution.",
    pitfalls: "1) Line numbers shift after edits — re-read the script first. 2) Breakpoints only hit in a running game (run_playtest).",
  },
  remove_breakpoint: {
    when_to_use: "Remove a breakpoint (unblock execution after debugging).",
    args_guide: "path* and line* (must match the set call).",
    example_call: '###MCP_TOOL###\n{"tool":"remove_breakpoint","args":{"path":"Workspace/Zombie/AI","line":42}}',
    output: "{queued:true,id} → removed async.",
    pitfalls: "1) Must match path+line exactly or nothing is removed. 2) Leftover breakpoints freeze playtests — clean up after.",
  },
  watch_variable: {
    when_to_use: "Watch a variable's value at a script path (observe state while debugging).",
    args_guide: "path* (script). variable* (name).",
    example_call: '###MCP_TOOL###\n{"tool":"watch_variable","args":{"path":"Workspace/Zombie/AI","variable":"health"}}',
    output: "{queued:true,id} → watch streaming async.",
    pitfalls: "1) Variable must be in scope at the watched point. 2) Locals optimized away may read nil.",
  },
  step_through: {
    when_to_use: "Step N lines from a breakpoint (walk buggy logic line by line).",
    args_guide: "path*. steps default 1.",
    example_call: '###MCP_TOOL###\n{"tool":"step_through","args":{"path":"Workspace/Zombie/AI","steps":3}}',
    output: "{queued:true,id} → stepped async. Resume with continue_execution.",
    pitfalls: "1) Requires a hit breakpoint first. 2) Stepping into yields/long waits can time out — keep steps small.",
  },
  continue_execution: {
    when_to_use: "Resume after breakpoint/stepping (finish the debug pause).",
    args_guide: "path optional. projectId optional.",
    example_call: '###MCP_TOOL###\n{"tool":"continue_execution","args":{}}',
    output: "{queued:true,id} → resumed async.",
    pitfalls: "1) Resuming with unremoved breakpoints re-pauses immediately. 2) Verify state with get_property_value after.",
  },
  generate_level: {
    when_to_use: "Generate a constrained level (obby, arena) from a prompt (fast playable layout).",
    args_guide: "prompt default obby. constraints optional map (size, difficulty, ...).",
    example_call: '###MCP_TOOL###\n{"tool":"generate_level","args":{"prompt":"lava obby","constraints":{"stages":10}}}',
    output: "{queued:true,id} → level queued async.",
    pitfalls: "1) Generated levels need a playtest pass — geometry often needs tuning. 2) Snapshot first; generation is additive and messy to undo by hand.",
  },
  get_projects: {
    when_to_use: "List known projects and the active one (orient before switching). Pure local.",
    args_guide: "No args.",
    example_call: '###MCP_TOOL###\n{"tool":"get_projects","args":{}}',
    output: "Immediate {projects, active}. Switch with switch_project.",
    pitfalls: "1) Project list is bridge-side — the open Studio place is authoritative. 2) Work in the wrong project is the classic mistake — check active first.",
  },
  switch_project: {
    when_to_use: "Switch the active project context (work on lobby vs obby).",
    args_guide: "projectId* (must exist — see get_projects).",
    example_call: '###MCP_TOOL###\n{"tool":"switch_project","args":{"projectId":"lobby"}}',
    output: "Immediate {switched:true}. Subsequent calls use it.",
    pitfalls: "1) Switching mid-batch misroutes queued calls — switch first, then queue. 2) Never invent project IDs.",
  },
  create_project: {
    when_to_use: "Create a new project, optionally from a template (start clean work).",
    args_guide: "projectId*. template optional (template ID).",
    example_call: '###MCP_TOOL###\n{"tool":"create_project","args":{"projectId":"zombie-game","template":"obby-base"}}',
    output: "{created:true} (+queued template code when applicable).",
    pitfalls: "1) Project IDs must be unique. 2) Unknown template IDs silently skip seeding — verify with get_projects.",
  },
  get_suggestions: {
    when_to_use: "Predictive next-tool suggestions from recent history (unstick yourself when unsure what to call).",
    args_guide: "context optional. projectId default.",
    example_call: '###MCP_TOOL###\n{"tool":"get_suggestions","args":{}}',
    output: "Immediate {suggestions:[...]}. Advisory only.",
    pitfalls: "1) Suggestions mirror history — a stuck loop suggests stuck tools. 2) Cold sessions get generic defaults.",
  },
  run_playtest: {
    when_to_use: "Run a real Studio playtest for N seconds (verify movement, physics, UI in a live game).",
    args_guide: "projectId default. durationSec default 5.",
    example_call: '###MCP_TOOL###\n{"tool":"run_playtest","args":{"durationSec":10}}',
    output: "{queued:true,id} → playtest runs async. Read results/metrics after.",
    pitfalls: "1) Needs a loaded place with valid spawn — fix startup errors first. 2) Short durations miss slow bugs; chain longer runs for AI behavior.",
  },
  export_project: {
    when_to_use: "Export a compact project archive snapshot (backup/share current state).",
    args_guide: "projectId default.",
    example_call: '###MCP_TOOL###\n{"tool":"export_project","args":{}}',
    output: "Immediate {exported:true, archive (truncated preview)}.",
    pitfalls: "1) Preview is truncated — the full archive lives server-side. 2) For disaster recovery prefer take_snapshot (restorable in one call).",
  },
  import_project: {
    when_to_use: "Import a project archive (restore an export_project backup).",
    args_guide: "archive* (base64 from export_project).",
    example_call: '###MCP_TOOL###\n{"tool":"import_project","args":{"archive":"<base64>"}}',
    output: "{imported:true, preview} (+queued import).",
    pitfalls: "1) Importing overwrites current state — snapshot first. 2) Corrupt/truncated archives fail — paste the full string.",
  },
  generate_quest: {
    when_to_use: "Generate a quest definition (objectives + rewards) for adventure/RPG loops.",
    args_guide: "theme default adventure. difficulty default medium.",
    example_call: '###MCP_TOOL###\n{"tool":"generate_quest","args":{"theme":"zombie","difficulty":"hard"}}',
    output: "Quest JSON + queued spawn code. Wire rewards into your economy after.",
    pitfalls: "1) Generated quests reference placeholder items — bind to real instances. 2) Balance rewards with simulate_economy before shipping.",
  },
  simulate_economy: {
    when_to_use: "Simulate economy balance over N iterations (will coins inflate?). Offline math, no Studio needed.",
    args_guide: "config optional (rates/sinks). iterations default 1000.",
    example_call: '###MCP_TOOL###\n{"tool":"simulate_economy","args":{"iterations":1000}}',
    output: "Immediate {iterations, inflation, balance}. Tune with suggest_balance.",
    pitfalls: "1) Model output, not live data — validate against real metrics. 2) Extreme configs give extreme answers; sanity-check inputs.",
  },
  suggest_balance: {
    when_to_use: "Get balance suggestions from analytics (fix snowballing, dead content).",
    args_guide: "projectId default.",
    example_call: '###MCP_TOOL###\n{"tool":"suggest_balance","args":{}}',
    output: "Immediate suggestions JSON.",
    pitfalls: "1) Needs metrics history — empty analytics give generic advice. 2) Apply via real build tools, then re-measure.",
  },
  explain_code: {
    when_to_use: "Get a plain-language explanation of code (understand inherited scripts). Offline.",
    args_guide: "code or path (one of them).",
    example_call: '###MCP_TOOL###\n{"tool":"explain_code","args":{"path":"Workspace/Zombie/AI"}}',
    output: "Immediate {explanation, issues, mermaid} JSON.",
    pitfalls: "1) Explanations describe intent, not runtime truth — verify live. 2) Huge files truncate; explain section by section.",
  },
  learning_mode: {
    when_to_use: "Toggle tutorial-style verbose output (learn while the agent builds).",
    args_guide: "enabled optional (omit = on).",
    example_call: '###MCP_TOOL###\n{"tool":"learning_mode","args":{"enabled":true}}',
    output: "Immediate {learningMode:true/false}.",
    pitfalls: "1) Verbose mode costs context on long builds — toggle off when fluent. 2) Session-scoped; resets on restart.",
  },
  adjust_difficulty: {
    when_to_use: "Apply one DDA adjustment from live metrics (rubber-band a too-hard fight).",
    args_guide: "projectId default. metrics optional (omit = latest).",
    example_call: '###MCP_TOOL###\n{"tool":"adjust_difficulty","args":{}}',
    output: "{queued:true,id} → adjustment applied async.",
    pitfalls: "1) Needs fresh metrics — stale data mistunes. 2) One adjustment at a time; re-measure before stacking.",
  },
  set_difficulty_profile: {
    when_to_use: "Set the DDA mode (easy/medium/hard/adaptive baseline for all adjustments).",
    args_guide: "profile* (easy|medium|hard|adaptive).",
    example_call: '###MCP_TOOL###\n{"tool":"set_difficulty_profile","args":{"profile":"adaptive"}}',
    output: "{queued:true,id} → profile set async.",
    pitfalls: "1) Adaptive needs metrics flow to adapt — else it sits at baseline. 2) Changing mid-fight confuses playtest reads.",
  },
  generate_sound: {
    when_to_use: "Generate one procedural sound (footstep, hit, UI click). No API key.",
    args_guide: "prompt*. type sfx|music|voice default sfx.",
    example_call: '###MCP_TOOL###\n{"tool":"generate_sound","args":{"prompt":"zombie groan","type":"sfx"}}',
    output: "{generated:true, path} + queued Sound spawn. Preview with play_sound.",
    pitfalls: "1) Placeholder asset ID until replaced — swap in the real rbxassetid. 2) Describe timbre ('wet growl'), not just the noun.",
  },
  generate_sound_pack: {
    when_to_use: "Generate a batch of related sounds (footsteps 1-4, UI kit) in one call.",
    args_guide: "prompt*. count default 3. type default sfx.",
    example_call: '###MCP_TOOL###\n{"tool":"generate_sound_pack","args":{"prompt":"coin pickup","count":3}}',
    output: "Immediate {pack:[{prompt,path}]}. Spawn via play_sound per item.",
    pitfalls: "1) Packs vary in loudness — normalize before shipping. 2) Keep counts small; curate, don't hoard.",
  },
  play_sound: {
    when_to_use: "Play a sound in Studio (audition generated audio, test cues).",
    args_guide: "path default workspace. soundId optional (omit = default/test sound).",
    example_call: '###MCP_TOOL###\n{"tool":"play_sound","args":{"soundId":"rbxassetid://123"}}',
    output: "{queued:true,id} → playing async.",
    pitfalls: "1) No soundId plays a default — always pass the real ID to judge. 2) Edit-mode playback may differ from in-game mix.",
  },
};

// Full set shipped to the extension bundle (lazy lookup; ~60KB one-time parse).
export const HOT_PROMPT_TOOLS: string[] = Object.keys(toolPrompts);

export function getToolPrompt(name: string): ToolPrompt | null {
  return toolPrompts[name] ?? null;
}
