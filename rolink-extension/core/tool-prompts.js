// rolink-extension/core/tool-prompts.js — GENERATED. Do not edit by hand.
// Re-emit with: npm run generate:prompts (from mcp-server/)
//
// Source of truth: mcp-server/src/tools/toolPrompts.ts (top-20 hot tools).
// Loaded by content scripts (see rolink-extension/manifest.json) AFTER
// core/code-fields.js. main.js consults window.ROLINK_TOOL_PROMPTS on the
// error-recovery path (failed tool -> usage + pitfalls fed back to model).
window.ROLINK_TOOL_PROMPTS = {
  "execute_luau": {
    "when_to_use": "Run arbitrary Luau in Studio (spawn parts, wire logic, fix scripts). Prefer ###LUA### blocks over JSON so quotes never need escaping. For creating objects with geometry prefer generate_asset; for simple parts use this.",
    "args_guide": "code* (Luau source; use game.Workspace, never just Workspace). datamodel_type auto-injected (Edit/Client/Server) \u2014 set explicitly only to override. timeoutMs default 20000.",
    "example_call": "###LUA###\nlocal p = Instance.new(\"Part\")\np.Size = Vector3.new(4, 1, 2)\np.Position = Vector3.new(0, 5, 0)\np.Parent = game.Workspace\n###END_LUA###",
    "output": "Returns execution result text or ERROR. On ERROR, read the message, fix the code, retry exactly once.",
    "pitfalls": "1) JSON-escaping bugs \u2014 use ###LUA###, never hand-escape quotes. 2) Yielding forever (while true without task.wait) hits timeout \u2014 keep loops bounded. 3) Nil parents \u2014 Parent to game.Workspace explicitly."
  },
  "get_instances": {
    "when_to_use": "Explore the game tree: list children of a path. ALWAYS the first call for vague tasks ('make the zombie move' \u2192 find the zombie model first). Alias search_game_tree / inspect_instance / get_instance_tree all resolve here \u2014 emit get_instances.",
    "args_guide": "path default 'workspace' (Workspace-relative, e.g. Workspace/Zombie). projectId optional.",
    "example_call": "###MCP_TOOL###\n{\"tool\":\"get_instances\",\"args\":{\"path\":\"Workspace\"}}",
    "output": "Immediate JSON list of children (names, classes). Drill down with deeper paths.",
    "pitfalls": "1) Emitting search_game_tree as its own tool \u2014 it is an alias, use get_instances. 2) Guessing deep paths \u2014 list top-down instead. 3) Case: 'Workspace' capital W in paths."
  },
  "find_instance": {
    "when_to_use": "Search by name/class/attribute when you know a keyword ('zombie') but not the path. Use after get_instances returns too much, or before mutating an uncertain path.",
    "args_guide": "query* (e.g. \"Zombie\"). searchType name|class|attribute default name.",
    "example_call": "###MCP_TOOL###\n{\"tool\":\"find_instance\",\"args\":{\"query\":\"Zombie\"}}",
    "output": "Immediate JSON matches with full paths \u2014 feed a match path into get/move/set calls.",
    "pitfalls": "1) Over-broad queries ('Part') flood results \u2014 add searchType class. 2) Use returned exact paths verbatim downstream."
  },
  "create_instance": {
    "when_to_use": "Create one new Instance (Part, Script, Folder, ...). For whole models use create_model_from_table; for UI use create_ui.",
    "args_guide": "className* (e.g. Part). parent default workspace. name optional. properties optional map.",
    "example_call": "###MCP_TOOL###\n{\"tool\":\"create_instance\",\"args\":{\"className\":\"Part\",\"parent\":\"Workspace\",\"name\":\"MyPart\"}}",
    "output": "{queued:true,id} \u2192 created async. Set properties with set_properties next if needed.",
    "pitfalls": "1) Forgetting parent \u2192 check where it landed with get_instances. 2) Wrong className spelling fails validation \u2014 use exact Roblox class names."
  },
  "set_properties": {
    "when_to_use": "Batch-update properties on an existing instance (move/resize/recolor). Read first with get_property_value if unsure of current values.",
    "args_guide": "path* (Workspace-relative). properties* map, e.g. {Position: ..., Color: ...}.",
    "example_call": "###MCP_TOOL###\n{\"tool\":\"set_properties\",\"args\":{\"path\":\"Workspace/MyPart\",\"properties\":{\"Anchored\":true}}}",
    "output": "{queued:true,id} \u2192 applied async.",
    "pitfalls": "1) Vector3/Color3 must be typed values, not strings. 2) resolve_path first if the path is uncertain."
  },
  "delete_instance": {
    "when_to_use": "Permanently destroy ONE instance. For renames/moves use set_properties/move_instance. For experiments, snapshot first.",
    "args_guide": "path* Workspace-relative (e.g. Workspace/OldPart).",
    "example_call": "###MCP_TOOL###\n{\"tool\":\"delete_instance\",\"args\":{\"path\":\"Workspace/OldPart\"}}",
    "output": "{queued:true,id} \u2192 deleted async.",
    "pitfalls": "1) IRREVERSIBLE without take_snapshot \u2014 snapshot first for anything non-trivial. 2) resolve_path first if unsure the path exists."
  },
  "move_instance": {
    "when_to_use": "Reparent an instance (organize, move into a model/folder). Not for changing Position \u2014 use set_properties.",
    "args_guide": "path* (what to move). newParent* (destination path).",
    "example_call": "###MCP_TOOL###\n{\"tool\":\"move_instance\",\"args\":{\"path\":\"Workspace/MyPart\",\"newParent\":\"Workspace/Models\"}}",
    "output": "{queued:true,id} \u2192 moved async.",
    "pitfalls": "1) Destination must exist \u2014 ensure_path first. 2) Moving scripts can break connections \u2014 prefer in-place edits."
  },
  "clone_instance": {
    "when_to_use": "Duplicate an instance (stamp out copies of a configured part/model).",
    "args_guide": "path*. newName optional. parent optional (default same parent).",
    "example_call": "###MCP_TOOL###\n{\"tool\":\"clone_instance\",\"args\":{\"path\":\"Workspace/MyPart\",\"newName\":\"MyPart2\"}}",
    "output": "{queued:true,id} \u2192 cloned async.",
    "pitfalls": "1) Clones inherit scripts/connections \u2014 check for duplicates firing twice. 2) Rename immediately to avoid name collisions."
  },
  "get_script_content": {
    "when_to_use": "Read a script's full source BEFORE editing or debugging it ('why doesn't the zombie move' \u2192 read ZombieMovement first). Alias script_search resolves here.",
    "args_guide": "path* (e.g. Workspace/Zombie/ZombieMovement).",
    "example_call": "###MCP_TOOL###\n{\"tool\":\"get_script_content\",\"args\":{\"path\":\"Workspace/Zombie/ZombieMovement\"}}",
    "output": "Immediate script source text. Read it, then decide: set_script_content for rewrites, execute_luau for live tweaks.",
    "pitfalls": "1) Never rewrite blind \u2014 read first. 2) Large scripts may truncate display; target sections via follow-up reads."
  },
  "set_script_content": {
    "when_to_use": "Write a script's full source (rewrite/fix). For small live tweaks prefer execute_luau. Use ###RAW:content### for long code to avoid JSON escaping.",
    "args_guide": "path*. content* (full new source). Use ###RAW:content### blocks for multi-line code.",
    "example_call": "###MCP_TOOL###\n{\"tool\":\"set_script_content\",\"args\":{\"path\":\"Workspace/Zombie/ZombieMovement\"}}\n###RAW:content###\n-- full fixed source here\n###END_RAW###",
    "output": "{queued:true,id} \u2192 written async. Verify with get_script_content or playtest.",
    "pitfalls": "1) This REPLACES the whole script \u2014 include unchanged parts. 2) take_snapshot first for non-trivial rewrites. 3) Raw quotes/newlines must go in ###RAW:content###, not JSON-escaped."
  },
  "create_module": {
    "when_to_use": "Create a ModuleScript with exported functions (shared logic). For plain scripts use create_instance + set_script_content.",
    "args_guide": "path*. exports* (Luau source of the module, must return a table).",
    "example_call": "###MCP_TOOL###\n{\"tool\":\"create_module\",\"args\":{\"path\":\"ReplicatedStorage/MathUtil\"}}\n###RAW:exports###\nlocal M = {}\nfunction M.add(a, b) return a + b end\nreturn M\n###END_RAW###",
    "output": "{queued:true,id} \u2192 created async. Call via run_function.",
    "pitfalls": "1) Module MUST return a table or require() fails. 2) Use ###RAW:exports### for the source."
  },
  "run_function": {
    "when_to_use": "Call an exported ModuleScript function without touching Studio manually (test shared logic live).",
    "args_guide": "path* (module). functionName*. args array default [].",
    "example_call": "###MCP_TOOL###\n{\"tool\":\"run_function\",\"args\":{\"path\":\"ReplicatedStorage/MathUtil\",\"functionName\":\"add\",\"args\":[1,2]}}",
    "output": "Return value JSON. On ERROR, read it \u2014 usually wrong functionName or arg count.",
    "pitfalls": "1) functionName is case-sensitive. 2) args must be a JSON array even for one arg."
  },
  "add_event_handler": {
    "when_to_use": "Attach a Lua handler to an instance event (button clicks, Touched). For UI clicks prefer bind_ui_click.",
    "args_guide": "path*. event* (e.g. Touched, Click). handlerCode* (Luau body). Use ###RAW:handlerCode### for multi-line.",
    "example_call": "###MCP_TOOL###\n{\"tool\":\"add_event_handler\",\"args\":{\"path\":\"Workspace/MyPart\",\"event\":\"Touched\"}}\n###RAW:handlerCode###\nprint(\"touched!\")\n###END_RAW###",
    "output": "{queued:true,id} \u2192 attached async.",
    "pitfalls": "1) Event names are case-sensitive (Touched not touched). 2) Keep handlers short \u2014 heavy logic belongs in a Script via set_script_content."
  },
  "take_snapshot": {
    "when_to_use": "Save a full DataModel snapshot BEFORE any destructive/multi-step work (deletes, rewrites, terrain, batch_queue). Cheap insurance.",
    "args_guide": "label optional (e.g. 'before-zombie-fix'). projectId default.",
    "example_call": "###MCP_TOOL###\n{\"tool\":\"take_snapshot\",\"args\":{\"label\":\"before-fix\"}}",
    "output": "{queued:true,id} \u2192 snapshot stored. Recover with rollback, compare with diff_snapshots.",
    "pitfalls": "1) Snapshot BEFORE the risky call, not after. 2) Label clearly \u2014 you will thank yourself at rollback time."
  },
  "rollback": {
    "when_to_use": "Revert to a snapshot after something broke. Pair with take_snapshot (before) and diff_snapshots (verify).",
    "args_guide": "projectId default. steps default 1, or snapshotId for a specific snapshot (mutually exclusive).",
    "example_call": "###MCP_TOOL###\n{\"tool\":\"rollback\",\"args\":{\"steps\":1}}",
    "output": "JSON of rolled-back entries. Confirm state with get_instances after.",
    "pitfalls": "1) steps vs snapshotId are exclusive \u2014 pass one. 2) Rollback reverts EVERYTHING since the snapshot, not one tool call."
  },
  "run_in_sandbox": {
    "when_to_use": "Test risky code isolated BEFORE touching the live game (new AI logic, untrusted snippets). Promote with confirm_sandbox_apply, drop with discard_sandbox.",
    "args_guide": "code* (Luau). Validated like execute_luau \u2014 same chrome/paren rules apply.",
    "example_call": "###LUA###\n-- candidate logic here\n###END_LUA###",
    "output": "{queued:true,id} \u2192 sandbox result. Then confirm_sandbox_apply or discard_sandbox.",
    "pitfalls": "1) Sandbox has no live game state \u2014 reads of Workspace may differ. 2) Never skip this for code you have not run before."
  },
  "batch_queue": {
    "when_to_use": "Run up to 20 independent commands in ONE call (scaffold a room: create 5 parts + set colors). Sequential fan-out \u2014 order is preserved.",
    "args_guide": "commands* array of {tool,args}. Max 20, no nesting (a sub batch_queue is rejected).",
    "example_call": "###MCP_TOOL###\n{\"tool\":\"batch_queue\",\"args\":{\"commands\":[{\"tool\":\"create_instance\",\"args\":{\"className\":\"Part\",\"name\":\"A\"}},{\"tool\":\"create_instance\",\"args\":{\"className\":\"Part\",\"name\":\"B\"}}]}}",
    "output": "{batched:N,succeeded:M,results:[...]} \u2014 inspect per-index results; fix only failures.",
    "pitfalls": "1) Dependent steps (create THEN move the same part) must be ordered \u2014 results carry indices. 2) Keep batches independent; chains belong in sequence across turns."
  },
  "resolve_path": {
    "when_to_use": "Check a path exists BEFORE mutating it (cheap guard before delete/set/move on uncertain paths).",
    "args_guide": "path*.",
    "example_call": "###MCP_TOOL###\n{\"tool\":\"resolve_path\",\"args\":{\"path\":\"Workspace/Zombie\"}}",
    "output": "Exists/missing verdict. Missing \u2192 ensure_path or correct the path.",
    "pitfalls": "1) Always guard destructive calls this way. 2) Paths are case-sensitive."
  },
  "ensure_path": {
    "when_to_use": "Create a missing folder path (organize before moving/creating). Idempotent \u2014 safe to call when unsure.",
    "args_guide": "path* (folder path to guarantee).",
    "example_call": "###MCP_TOOL###\n{\"tool\":\"ensure_path\",\"args\":{\"path\":\"Workspace/Models/Enemies\"}}",
    "output": "Path guaranteed. Then move_instance/create_instance into it.",
    "pitfalls": "1) Only creates containers, not script contents. 2) Verify with get_instances after."
  },
  "generate_asset": {
    "when_to_use": "Text-to-3D/texture for objects with real geometry (tower mesh, crates, props). Procedural, no API key. For simple cubes/cylinders use execute_luau + Instance.new instead.",
    "args_guide": "prompt* (describe shape/material). kind model|texture default model.",
    "example_call": "###MCP_TOOL###\n{\"tool\":\"generate_asset\",\"args\":{\"prompt\":\"medieval stone tower\",\"kind\":\"model\"}}",
    "output": "{queued:true,id} + generationId \u2192 generation runs async; follow up (wait/job tools) with that exact ID.",
    "pitfalls": "1) NEVER invent generation IDs \u2014 use the returned one verbatim. 2) Simple primitives do not need this tool. 3) Describe materials, not just names."
  }
};
