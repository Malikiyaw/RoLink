# RoLink ↔ Roblox Studio Equivalence Map

Every Studio menu the builder touches has a RoLink tool twin. When the model
thinks "I would click X in Studio", it must emit the mapped tool instead of
prose. Referenced by the system prompt (`core/config.js` → `PERSONA_NOTE`).

| Studio menu / surface | What you do there | RoLink tool(s) |
|---|---|---|
| Explorer | Browse the game tree, find objects | `get_instances`, `find_instance`, `resolve_path` |
| Explorer | Insert / delete / duplicate / move objects | `create_instance`, `delete_instance`, `clone_instance`, `move_instance`, `ensure_path` |
| Explorer | Insert ModuleScript, wire events | `create_module`, `add_event_handler`, `remove_event_handler` |
| Explorer | Insert lighting / effects objects | `set_lighting`, `add_particle_emitter` |
| Properties | Read / edit property values | `get_property_value`, `get_all_properties`, `set_properties` |
| Toolbox / Creator Store | Search + insert models, meshes, images, audio | `search_asset`, `import_asset`, `generate_asset` |
| Animation Editor | Keyframe tracks, preview playback | `create_animation_track`, `play_animation` |
| Terrain Editor | Generate, select, fill terrain regions | `generate_terrain`, `set_terrain_region` |
| Material Manager | Apply materials | `apply_material` |
| Model tab | Pattern duplication, grouping | `place_parts`, `create_model_from_table` |
| UI Editor | Build ScreenGuis, tweak, bind clicks | `create_ui`, `set_ui_property`, `get_ui_tree`, `bind_ui_click` |
| Sound | Create + audition Sound objects | `generate_sound`, `generate_sound_pack`, `play_sound` |
| Script Editor | Read / write / review / refactor code | `get_script_content`, `set_script_content`, `execute_luau`, `run_function`, `review_code`, `refactor_code`, `explain_code` |
| Script Editor | Breakpoints, watch, step, continue | `set_breakpoint`, `remove_breakpoint`, `watch_variable`, `step_through`, `continue_execution` |
| Script Analysis | Warnings, perf hotspots, bug prediction | `predict_bug`, `analyze_performance`, `optimize_performance` |
| Command bar | Run snippets, call module functions | `execute_luau`, `run_function`, `get_global_variables` |
| Playtest / Simulate | Start, simulate ticks, sandbox trials | `run_playtest`, `simulate_ticks`, `run_in_sandbox`, `confirm_sandbox_apply`, `discard_sandbox` |
| Test tab | Generate + run tests | `generate_test`, `run_tests` |
| Asset Manager | Save / reuse templates, import archives | `list_templates`, `apply_template`, `add_template`, `export_project`, `import_project` |
| Team Collaboration | Presence, sessions, checkpoints | `session_users`, `list_sessions`, `replay_session`, `export_session_log`, `compare_sessions`, `git_commit`, `git_log`, `git_rollback` |
| DataStores manager | Schema, read, write keys | `setup_datastore`, `get_datastore_value`, `set_datastore_value` |
| Developer Console | Metrics, memory, analytics | `report_metrics`, `get_metrics`, `get_memory_usage`, `get_performance_stats`, `report_analytics`, `get_analytics` |
| Stats / Script Performance | Timings, thresholds, DDA tuning | `set_performance_threshold`, `adjust_difficulty`, `set_difficulty_profile` |
| Plugins tab | List / load extensions | `list_plugins`, `load_plugin` |
| Output window | Logs, watch output | `send_notification`, `get_suggestions` |
| File menu | Save-as backup, revert, new project | `take_snapshot`, `rollback`, `diff_snapshots`, `get_projects`, `switch_project`, `create_project` |
| Design docs / planning | GDD, quests, levels, economy, difficulty | `plan_game`, `execute_plan`, `generate_level`, `generate_quest`, `simulate_economy`, `suggest_balance`, `suggest_design`, `compile_visual_graph`, `train_model`, `learning_mode`, `batch_queue`, `cancel_command`, `validate_command`, `suggest_ordering`, `get_dependency_graph`, `get_function_signatures`, `search_by_attribute`, `get_referenced_instances`, `get_context_summary`, `get_time` |

Notes:

- `batch_queue` is the twin of "do several Explorer/Properties edits in one go"
  (up to 20 ordered commands); chain async generation IDs across turns.
- There is no multi-edit tool: multi-line script rewrites go through
  `set_script_content` with `###RAW:content###` blocks.
- Snapshots (`take_snapshot`) are the twin of File → Save As; they are the
  only undo for destructive Terrain / delete / rewrite work.
