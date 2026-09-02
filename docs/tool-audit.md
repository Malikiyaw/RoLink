# RoLink tool audit

Generated from `mcp-server/src/tools/registry.ts` with `npm run audit:tools`.

**Static audit is not a live Studio verification.** The "Studio Y/N" column is intentionally "N" until the tool is executed against a real Roblox Studio session.

| # | Tool | Tier | Schema | Handler | Error path | Studio Y/N |
|---:|---|---|---|---|---|:---:|
| 1 | `get_instances` | T3 | OK | wired | review | N |
| 2 | `create_instance` | T1/T2 | OK | wired | review | N |
| 3 | `set_properties` | T1/T2 | OK | wired | review | N |
| 4 | `delete_instance` | T1/T2 | OK | wired | review | N |
| 5 | `clone_instance` | T1/T2 | OK | wired | review | N |
| 6 | `move_instance` | T1/T2 | OK | wired | review | N |
| 7 | `find_instance` | T3 | OK | wired | review | N |
| 8 | `execute_luau` | T1/T2 | OK | wired | reviewed | N |
| 9 | `get_script_content` | T3 | OK | wired | review | N |
| 10 | `set_script_content` | T1/T2 | OK | wired | review | N |
| 11 | `create_module` | T1/T2 | OK | wired | review | N |
| 12 | `run_function` | T1/T2 | OK | wired | review | N |
| 13 | `add_event_handler` | T2 | OK | wired | review | N |
| 14 | `remove_event_handler` | T1/T2 | OK | wired | review | N |
| 15 | `get_global_variables` | T3 | OK | wired | review | N |
| 16 | `take_snapshot` | T2 | OK | wired | review | N |
| 17 | `rollback` | T1/T2 | OK | wired | review | N |
| 18 | `diff_snapshots` | T3 | OK | wired | review | N |
| 19 | `run_in_sandbox` | T1/T2 | OK | wired | reviewed | N |
| 20 | `confirm_sandbox_apply` | T1/T2 | OK | wired | review | N |
| 21 | `discard_sandbox` | T2 | OK | wired | review | N |
| 22 | `simulate_ticks` | T2 | OK | wired | review | N |
| 23 | `get_context_summary` | T3 | OK | wired | review | N |
| 24 | `get_function_signatures` | T3 | OK | wired | review | N |
| 25 | `get_property_value` | T3 | OK | wired | review | N |
| 26 | `get_all_properties` | T3 | OK | wired | review | N |
| 27 | `search_by_attribute` | T3 | OK | wired | review | N |
| 28 | `get_referenced_instances` | T3 | OK | wired | review | N |
| 29 | `resolve_path` | T2 | OK | wired | review | N |
| 30 | `ensure_path` | T2 | OK | wired | review | N |
| 31 | `get_dependency_graph` | T3 | OK | wired | review | N |
| 32 | `suggest_ordering` | T3 | OK | wired | review | N |
| 33 | `validate_command` | T2 | OK | wired | review | N |
| 34 | `get_performance_stats` | T3 | OK | wired | review | N |
| 35 | `analyze_performance` | T2 | OK | wired | review | N |
| 36 | `set_performance_threshold` | T1/T2 | OK | wired | review | N |
| 37 | `get_memory_usage` | T3 | OK | wired | review | N |
| 38 | `generate_terrain` | T1/T2 | OK | wired | review | N |
| 39 | `set_terrain_region` | T1/T2 | OK | wired | review | N |
| 40 | `place_parts` | T2 | OK | wired | review | N |
| 41 | `create_model_from_table` | T1/T2 | OK | wired | review | N |
| 42 | `apply_material` | T1/T2 | OK | wired | review | N |
| 43 | `create_ui` | T1/T2 | OK | wired | review | N |
| 44 | `set_ui_property` | T1/T2 | OK | wired | review | N |
| 45 | `get_ui_tree` | T3 | OK | wired | review | N |
| 46 | `bind_ui_click` | T2 | OK | wired | review | N |
| 47 | `create_animation_track` | T1/T2 | OK | wired | review | N |
| 48 | `play_animation` | T2 | OK | wired | review | N |
| 49 | `set_lighting` | T1/T2 | OK | wired | review | N |
| 50 | `add_particle_emitter` | T2 | OK | wired | review | N |
| 51 | `setup_datastore` | T1/T2 | OK | wired | review | N |
| 52 | `get_datastore_value` | T3 | OK | wired | review | N |
| 53 | `set_datastore_value` | T1/T2 | OK | wired | review | N |
| 54 | `export_session_log` | T2 | OK | wired | review | N |
| 55 | `replay_session` | T2 | OK | wired | review | N |
| 56 | `list_sessions` | T3 | OK | wired | review | N |
| 57 | `compare_sessions` | T2 | OK | wired | review | N |
| 58 | `list_templates` | T3 | OK | wired | review | N |
| 59 | `apply_template` | T1/T2 | OK | wired | reviewed | N |
| 60 | `add_template` | T2 | OK | wired | review | N |
| 61 | `get_time` | T3 | REVIEW | wired | review | N |
| 62 | `send_notification` | T2 | OK | wired | review | N |
| 63 | `batch_queue` | T2 | OK | wired | review | N |
| 64 | `cancel_command` | T2 | OK | wired | review | N |
| 65 | `train_model` | T2 | OK | wired | review | N |
| 66 | `compile_visual_graph` | T2 | OK | wired | review | N |
| 67 | `generate_test` | T1/T2 | OK | wired | review | N |
| 68 | `run_tests` | T1/T2 | OK | wired | review | N |
| 69 | `session_users` | T2 | OK | wired | review | N |
| 70 | `search_asset` | T1/T2 | OK | wired | review | N |
| 71 | `import_asset` | T1/T2 | OK | wired | review | N |
| 72 | `report_metrics` | T3 | OK | wired | review | N |
| 73 | `get_metrics` | T3 | OK | wired | review | N |
| 74 | `git_commit` | T1/T2 | OK | wired | review | N |
| 75 | `git_log` | T2 | OK | wired | review | N |
| 76 | `git_rollback` | T1/T2 | OK | wired | review | N |
| 77 | `predict_bug` | T2 | OK | wired | review | N |
| 78 | `plan_game` | T2 | OK | wired | review | N |
| 79 | `execute_plan` | T1/T2 | OK | wired | review | N |
| 80 | `review_code` | T2 | OK | wired | review | N |
| 81 | `refactor_code` | T2 | OK | wired | review | N |
| 82 | `generate_asset` | T1/T2 | OK | wired | review | N |
| 83 | `optimize_performance` | T2 | OK | wired | review | N |
| 84 | `report_analytics` | T3 | OK | wired | review | N |
| 85 | `get_analytics` | T3 | OK | wired | review | N |
| 86 | `suggest_design` | T3 | OK | wired | review | N |
| 87 | `list_plugins` | T3 | REVIEW | wired | review | N |
| 88 | `load_plugin` | T2 | OK | wired | reviewed | N |
| 89 | `set_breakpoint` | T1/T2 | OK | wired | review | N |
| 90 | `remove_breakpoint` | T1/T2 | OK | wired | review | N |
| 91 | `watch_variable` | T2 | OK | wired | review | N |
| 92 | `step_through` | T2 | OK | wired | review | N |
| 93 | `continue_execution` | T2 | OK | wired | review | N |
| 94 | `generate_level` | T1/T2 | OK | wired | review | N |
| 95 | `get_projects` | T3 | REVIEW | wired | review | N |
| 96 | `switch_project` | T2 | OK | wired | review | N |
| 97 | `create_project` | T1/T2 | OK | wired | review | N |
| 98 | `get_suggestions` | T3 | OK | wired | review | N |
| 99 | `run_playtest` | T1/T2 | OK | wired | review | N |
| 100 | `export_project` | T2 | OK | wired | review | N |
| 101 | `import_project` | T1/T2 | OK | wired | reviewed | N |
| 102 | `generate_quest` | T1/T2 | OK | wired | review | N |
| 103 | `simulate_economy` | T2 | OK | wired | review | N |
| 104 | `suggest_balance` | T3 | OK | wired | review | N |
| 105 | `explain_code` | T2 | OK | wired | review | N |
| 106 | `learning_mode` | T2 | OK | wired | review | N |
| 107 | `adjust_difficulty` | T2 | OK | wired | review | N |
| 108 | `set_difficulty_profile` | T1/T2 | OK | wired | review | N |
| 109 | `generate_sound` | T1/T2 | OK | wired | review | N |
| 110 | `generate_sound_pack` | T1/T2 | OK | wired | review | N |
| 111 | `play_sound` | T2 | OK | wired | review | N |

## Live verification rule

Tier 1 and Tier 2 tools must be run against a live Roblox Studio place before the final status is changed to Y. A result must be recorded, not inferred from a successful enqueue.
