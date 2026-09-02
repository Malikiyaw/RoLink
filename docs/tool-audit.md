# RoLink tool audit

Generated from `mcp-server/src/tools/registry.ts` with `npm run audit:tools`.

**Static audit is not a live Studio verification.** The "Studio Y/N" column is intentionally "N" until the tool is executed against a real Roblox Studio session.

**Dispatch-safe** is a parser-layer guarantee: "yes" = the parser can hand the tool a non-empty .tool and .args; "partial" = the tool carries a code-bearing string field that the parser knows how to handle but the model can still produce an unparsable shape if it bypasses the format; "no" = a known gap (zero such tools today, see `tools/registry.ts` for source of truth).

| # | Tool | Tier | Schema | Handler | Error path | Studio Y/N | Dispatch-safe |
|---:|---|---|---|---|---|:---:|:---:|
| 1 | `get_instances` | T3 | OK | wired | review | N | yes |
| 2 | `create_instance` | T1/T2 | OK | wired | review | N | yes |
| 3 | `set_properties` | T1/T2 | OK | wired | review | N | yes |
| 4 | `delete_instance` | T1/T2 | OK | wired | review | N | yes |
| 5 | `clone_instance` | T1/T2 | OK | wired | review | N | yes |
| 6 | `move_instance` | T1/T2 | OK | wired | review | N | yes |
| 7 | `find_instance` | T3 | OK | wired | review | N | yes |
| 8 | `execute_luau` | T1/T2 | OK | wired | reviewed | N | yes |
| 9 | `get_script_content` | T3 | OK | wired | review | N | yes |
| 10 | `set_script_content` | T1/T2 | OK | wired | review | N | yes |
| 11 | `create_module` | T1/T2 | OK | wired | review | N | yes |
| 12 | `run_function` | T1/T2 | OK | wired | review | N | yes |
| 13 | `add_event_handler` | T2 | OK | wired | review | N | yes |
| 14 | `remove_event_handler` | T1/T2 | OK | wired | review | N | yes |
| 15 | `get_global_variables` | T3 | OK | wired | review | N | yes |
| 16 | `take_snapshot` | T2 | OK | wired | review | N | yes |
| 17 | `rollback` | T1/T2 | OK | wired | review | N | yes |
| 18 | `diff_snapshots` | T3 | OK | wired | review | N | yes |
| 19 | `run_in_sandbox` | T1/T2 | OK | wired | reviewed | N | yes |
| 20 | `confirm_sandbox_apply` | T1/T2 | OK | wired | review | N | yes |
| 21 | `discard_sandbox` | T2 | OK | wired | review | N | yes |
| 22 | `simulate_ticks` | T2 | OK | wired | review | N | yes |
| 23 | `get_context_summary` | T3 | OK | wired | review | N | yes |
| 24 | `get_function_signatures` | T3 | OK | wired | review | N | yes |
| 25 | `get_property_value` | T3 | OK | wired | review | N | yes |
| 26 | `get_all_properties` | T3 | OK | wired | review | N | yes |
| 27 | `search_by_attribute` | T3 | OK | wired | review | N | yes |
| 28 | `get_referenced_instances` | T3 | OK | wired | review | N | yes |
| 29 | `resolve_path` | T2 | OK | wired | review | N | yes |
| 30 | `ensure_path` | T2 | OK | wired | review | N | yes |
| 31 | `get_dependency_graph` | T3 | OK | wired | review | N | yes |
| 32 | `suggest_ordering` | T3 | OK | wired | review | N | yes |
| 33 | `validate_command` | T2 | OK | wired | review | N | yes |
| 34 | `get_performance_stats` | T3 | OK | wired | review | N | yes |
| 35 | `analyze_performance` | T2 | OK | wired | review | N | yes |
| 36 | `set_performance_threshold` | T1/T2 | OK | wired | review | N | yes |
| 37 | `get_memory_usage` | T3 | OK | wired | review | N | yes |
| 38 | `generate_terrain` | T1/T2 | OK | wired | review | N | yes |
| 39 | `set_terrain_region` | T1/T2 | OK | wired | review | N | yes |
| 40 | `place_parts` | T2 | OK | wired | review | N | yes |
| 41 | `create_model_from_table` | T1/T2 | OK | wired | review | N | yes |
| 42 | `apply_material` | T1/T2 | OK | wired | review | N | yes |
| 43 | `create_ui` | T1/T2 | OK | wired | review | N | yes |
| 44 | `set_ui_property` | T1/T2 | OK | wired | review | N | yes |
| 45 | `get_ui_tree` | T3 | OK | wired | review | N | yes |
| 46 | `bind_ui_click` | T2 | OK | wired | review | N | yes |
| 47 | `create_animation_track` | T1/T2 | OK | wired | review | N | yes |
| 48 | `play_animation` | T2 | OK | wired | review | N | yes |
| 49 | `set_lighting` | T1/T2 | OK | wired | review | N | yes |
| 50 | `add_particle_emitter` | T2 | OK | wired | review | N | yes |
| 51 | `setup_datastore` | T1/T2 | OK | wired | review | N | yes |
| 52 | `get_datastore_value` | T3 | OK | wired | review | N | yes |
| 53 | `set_datastore_value` | T1/T2 | OK | wired | review | N | yes |
| 54 | `export_session_log` | T2 | OK | wired | review | N | yes |
| 55 | `replay_session` | T2 | OK | wired | review | N | yes |
| 56 | `list_sessions` | T3 | OK | wired | review | N | yes |
| 57 | `compare_sessions` | T2 | OK | wired | review | N | yes |
| 58 | `list_templates` | T3 | OK | wired | review | N | yes |
| 59 | `apply_template` | T1/T2 | OK | wired | reviewed | N | yes |
| 60 | `add_template` | T2 | OK | wired | review | N | yes |
| 61 | `get_time` | T3 | REVIEW | wired | review | N | yes |
| 62 | `send_notification` | T2 | OK | wired | review | N | yes |
| 63 | `batch_queue` | T2 | OK | wired | review | N | yes |
| 64 | `cancel_command` | T2 | OK | wired | review | N | yes |
| 65 | `train_model` | T2 | OK | wired | review | N | yes |
| 66 | `compile_visual_graph` | T2 | OK | wired | review | N | yes |
| 67 | `generate_test` | T1/T2 | OK | wired | review | N | yes |
| 68 | `run_tests` | T1/T2 | OK | wired | review | N | yes |
| 69 | `session_users` | T2 | OK | wired | review | N | yes |
| 70 | `search_asset` | T1/T2 | OK | wired | review | N | yes |
| 71 | `import_asset` | T1/T2 | OK | wired | review | N | yes |
| 72 | `report_metrics` | T3 | OK | wired | review | N | yes |
| 73 | `get_metrics` | T3 | OK | wired | review | N | yes |
| 74 | `git_commit` | T1/T2 | OK | wired | review | N | yes |
| 75 | `git_log` | T2 | OK | wired | review | N | yes |
| 76 | `git_rollback` | T1/T2 | OK | wired | review | N | yes |
| 77 | `predict_bug` | T2 | OK | wired | review | N | yes |
| 78 | `plan_game` | T2 | OK | wired | review | N | yes |
| 79 | `execute_plan` | T1/T2 | OK | wired | review | N | yes |
| 80 | `review_code` | T2 | OK | wired | review | N | yes |
| 81 | `refactor_code` | T2 | OK | wired | review | N | yes |
| 82 | `generate_asset` | T1/T2 | OK | wired | review | N | yes |
| 83 | `optimize_performance` | T2 | OK | wired | review | N | yes |
| 84 | `report_analytics` | T3 | OK | wired | review | N | yes |
| 85 | `get_analytics` | T3 | OK | wired | review | N | yes |
| 86 | `suggest_design` | T3 | OK | wired | review | N | yes |
| 87 | `list_plugins` | T3 | REVIEW | wired | review | N | yes |
| 88 | `load_plugin` | T2 | OK | wired | reviewed | N | yes |
| 89 | `set_breakpoint` | T1/T2 | OK | wired | review | N | yes |
| 90 | `remove_breakpoint` | T1/T2 | OK | wired | review | N | yes |
| 91 | `watch_variable` | T2 | OK | wired | review | N | yes |
| 92 | `step_through` | T2 | OK | wired | review | N | yes |
| 93 | `continue_execution` | T2 | OK | wired | review | N | yes |
| 94 | `generate_level` | T1/T2 | OK | wired | review | N | yes |
| 95 | `get_projects` | T3 | REVIEW | wired | review | N | yes |
| 96 | `switch_project` | T2 | OK | wired | review | N | yes |
| 97 | `create_project` | T1/T2 | OK | wired | review | N | yes |
| 98 | `get_suggestions` | T3 | OK | wired | review | N | yes |
| 99 | `run_playtest` | T1/T2 | OK | wired | review | N | yes |
| 100 | `export_project` | T2 | OK | wired | review | N | yes |
| 101 | `import_project` | T1/T2 | OK | wired | reviewed | N | yes |
| 102 | `generate_quest` | T1/T2 | OK | wired | review | N | yes |
| 103 | `simulate_economy` | T2 | OK | wired | review | N | yes |
| 104 | `suggest_balance` | T3 | OK | wired | review | N | yes |
| 105 | `explain_code` | T2 | OK | wired | review | N | yes |
| 106 | `learning_mode` | T2 | OK | wired | review | N | yes |
| 107 | `adjust_difficulty` | T2 | OK | wired | review | N | yes |
| 108 | `set_difficulty_profile` | T1/T2 | OK | wired | review | N | yes |
| 109 | `generate_sound` | T1/T2 | OK | wired | review | N | yes |
| 110 | `generate_sound_pack` | T1/T2 | OK | wired | review | N | yes |
| 111 | `play_sound` | T2 | OK | wired | review | N | yes |

## Live verification rule

Tier 1 and Tier 2 tools must be run against a live Roblox Studio place before the final status is changed to Y. A result must be recorded, not inferred from a successful enqueue.

## Summary

- Total: 111 tools
- Dispatch-safe "yes": 111 (all)
- Dispatch-safe "partial": 0
- Dispatch-safe "no": 0
